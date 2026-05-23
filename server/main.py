# server/main.py
from dotenv import load_dotenv
from fastmcp import FastMCP
from pydantic import BaseModel

import server.db.models  # noqa: F401
from server.db.base import Base, engine
from server.db.repo import (
    create_attempt as db_create_attempt,
)
from server.db.repo import (
    get_active_attempt,
    record_event,
)
from server.db.repo import (
    get_problem as db_get_problem,
)
from server.db.repo import (
    list_problems as db_list_problems,
)
from server.db.schemas import AttemptRead, ProblemCatalogRead, ProblemSummaryRead
from server.db.seed import seed_problems
from server.hints.engine import HintEngine
from server.hints.jailbreak import check_jailbreak, get_refusal
from server.llm_provider import get_provider
from server.workspace import write_active_problem

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
def start_problem(problem_id: str, language: str = "python") -> AttemptRead:
    """Start a new attempt on a problem.

    Writes problem.md and solution.{ext} to ~/.interview-mcp/active/.
    Registers the attempt as active, replacing any existing active attempt.

    Args:
        problem_id: The problem ID to start (e.g. '0001').
        language: Language to use. Defaults to 'python'.
    """
    problem = db_get_problem(problem_id)
    if problem is None:
        raise ValueError(f"Problem '{problem_id}' not found.")

    starter_code = problem.starter_code.get(language)
    if starter_code is None:
        raise ValueError(
            f"No starter code for language '{language}' on problem '{problem_id}'. "
            f"Available: {sorted(problem.starter_code.keys())}"
        )

    write_active_problem(
        problem_id=problem.id,
        title=problem.title,
        description_md=problem.description_md,
        starter_code=starter_code,
        language=language,
    )

    return db_create_attempt(problem_id=problem_id, language=language)


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
