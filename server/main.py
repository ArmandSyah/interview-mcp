# server/main.py
from dotenv import load_dotenv
from fastmcp import FastMCP
from pydantic import BaseModel

import server.db.models  # noqa: F401
from server.core.mode import get_execution_mode
from server.db.base import Base, engine
from server.db.repo import (
    create_attempt as db_create_attempt,
)
from server.db.repo import (
    get_active_attempt,
    get_attempt,
    record_event,
)
from server.db.repo import (
    get_problem as db_get_problem,
)
from server.db.repo import (
    list_problems as db_list_problems,
)
from server.db.schemas import ProblemCatalogRead, ProblemRead, ProblemSummaryRead
from server.db.seed import seed_problems
from server.hints.engine import HintEngine
from server.hints.jailbreak import check_jailbreak, get_refusal
from server.llm_provider import get_provider
from server.tool_models import ScaffoldFile, StartProblemResult
from server.workspace import (
    build_solution_scaffold_contents,
    scaffold_sha256,
    write_solution_scaffold,
)

load_dotenv()
mcp = FastMCP("interview-mcp")

_hint_engine: HintEngine | None = None


def _get_hint_engine() -> HintEngine:
    global _hint_engine
    if _hint_engine is None:
        _hint_engine = HintEngine(get_provider())
    return _hint_engine


def on_startup() -> None:
    Base.metadata.create_all(engine)
    seed_problems()
    _get_hint_engine()


@mcp.tool
def ping() -> str:
    """Health check. Returns 'pong'."""
    return "pong"


@mcp.tool
def get_problem_catalog() -> ProblemCatalogRead:
    """Return all available difficulties, tags, and pattern_tags.

    Call this before list_problems to know what filter values are valid.
    """
    problems = db_list_problems()
    difficulties = sorted({p.difficulty for p in problems})
    tags = sorted({t for p in problems for t in p.tags})
    pattern_tags = sorted({t for p in problems for t in p.pattern_tags})
    return ProblemCatalogRead(
        difficulties=difficulties,
        tags=tags,
        pattern_tags=pattern_tags,
    )


@mcp.tool
def list_problems(
    difficulty: str | None = None, tag: str | None = None
) -> list[ProblemSummaryRead]:
    """List available problems.

    Args:
        difficulty: Filter by difficulty ('easy', 'medium', 'hard'). Optional.
        tag: Filter by tag (e.g. 'array', 'sliding-window'). Optional.
    """
    problems = db_list_problems(difficulty=difficulty, tag=tag)
    return [ProblemSummaryRead.model_validate(p) for p in problems]


@mcp.tool
def start_problem(problem_id: str, language: str = "python") -> StartProblemResult:
    """Start a problem and provide the solution.py scaffold.

    Local mode writes ./<problem_id>/solution.py. Remote mode returns the same
    scaffold as a file artifact and writes nothing.

    Args:
        problem_id: The problem ID to start (e.g. '0001').
        language: Language to use. Python is the only week-2 supported language.
    """
    if language != "python":
        raise ValueError("start_problem currently supports Python only.")

    problem = db_get_problem(problem_id)
    if problem is None:
        raise ValueError(f"Problem '{problem_id}' not found.")

    starter_code = problem.starter_code.get(language)
    if starter_code is None:
        raise ValueError(
            f"No starter code for language '{language}' on problem '{problem_id}'. "
            f"Available: {sorted(problem.starter_code.keys())}"
        )

    attempt = db_create_attempt(problem_id=problem.id, language=language)
    example_input, example_output = _first_example_fields(problem)
    contents = build_solution_scaffold_contents(
        problem_id=problem.id,
        title=problem.title,
        difficulty=problem.difficulty,
        pattern_tag=problem.pattern_tags[0] if problem.pattern_tags else "",
        one_line_description=_one_line_description(problem),
        example_input=example_input,
        example_output=example_output,
        starter_code=starter_code,
    )

    relative_path = f"{problem.id}/solution.py"
    mode = get_execution_mode()

    if mode == "remote":
        return StartProblemResult(
            attempt_id=attempt.id,
            problem_id=problem.id,
            problem_title=problem.title,
            mode="remote",
            files_to_create=[
                ScaffoldFile(
                    relative_path=relative_path,
                    language=language,
                    contents=contents,
                    sha256=scaffold_sha256(contents),
                )
            ],
            instructions=(
                f"Create `{relative_path}` in your local workspace, edit it, then call "
                f"run_tests(attempt_id={attempt.id!r}, code=<contents of solution.py>)."
            ),
        )

    path = write_solution_scaffold(
        problem_id=problem.id,
        contents=contents,
        language=language,
    )
    return StartProblemResult(
        attempt_id=attempt.id,
        problem_id=problem.id,
        problem_title=problem.title,
        mode="local",
        files_written=[str(path)],
        instructions=(
            f"Open `{path}`, edit it, then call "
            f"run_tests(attempt_id={attempt.id!r}, code=<contents of solution.py>)."
        ),
    )


def _first_example_fields(problem: ProblemRead) -> tuple[str, str]:
    if not problem.examples:
        return "", ""
    example = problem.examples[0]
    return example.input, example.output


def _one_line_description(problem: ProblemRead) -> str:
    for line in problem.description_md.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped.lstrip("# ").strip()
    return problem.title


@mcp.tool
def get_problem_description(attempt_id: str) -> str:
    """Return the full problem description for an attempt."""
    attempt = get_attempt(attempt_id)
    if attempt is None:
        return f"Attempt {attempt_id!r} not found. Call start_problem first."

    problem = db_get_problem(attempt.problem_id)
    if problem is None:
        return "Problem for this attempt could not be found."

    examples = "\n\n".join(
        f"Input: {example.input}\nOutput: {example.output}"
        + (f"\nExplanation: {example.explanation}" if example.explanation else "")
        for example in problem.examples
    )
    constraints = "\n".join(f"- {item}" for item in problem.constraints)
    return (
        f"# {problem.title}\n\n"
        f"{problem.description_md}\n\n"
        f"## Examples\n{examples}\n\n"
        f"## Constraints\n{constraints}"
    )


class HintResult(BaseModel):
    hint: str
    depth: int
    used_fallback: bool


@mcp.tool
def get_hint(current_code: str, depth: int = 1) -> HintResult:
    """Get a hint for the active problem.

    Call this when you want a nudge without seeing the solution.
    Depth controls how much is revealed: 1 = conceptual nudge,
    2 = names the relevant pattern or data structure,
    3 = describes the algorithm in natural language.

    Args:
        current_code: Your current solution attempt. Pass the full file contents.
        depth: Hint depth 1-3. Start at 1, increase only if stuck.
    """
    is_jailbreak, pattern_name = check_jailbreak(current_code)
    if is_jailbreak:
        record_event(
            attempt_id="unknown",
            kind="jailbreak_blocked",
            payload={"pattern": pattern_name, "source": "current_code"},
        )
        return HintResult(hint=get_refusal(), depth=depth, used_fallback=False)

    attempt = get_active_attempt()
    if attempt is None:
        raise ValueError("No active problem. Call start_problem first.")

    problem = db_get_problem(attempt.problem_id)
    if problem is None:
        raise ValueError(f"Problem '{attempt.problem_id}' not found in database.")

    engine_instance = _get_hint_engine()
    hint, metadata = engine_instance.generate_hint(
        attempt=attempt,
        problem=problem,
        current_code=current_code,
        depth=depth,
    )

    record_event(
        attempt_id=attempt.id,
        kind="hint_requested",
        payload={
            "depth": depth,
            "latency_ms": metadata["latency_ms"],
            "used_fallback": metadata["used_fallback"],
            "fallback_reason": metadata["fallback_reason"],
        },
    )

    return HintResult(
        hint=hint,
        depth=depth,
        used_fallback=bool(metadata["used_fallback"]),
    )


if __name__ == "__main__":
    on_startup()
    mcp.run()
