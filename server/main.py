# server/main.py
import os
from collections.abc import Sequence

from dotenv import load_dotenv
from fastmcp import FastMCP
from pydantic import BaseModel

import server.db.models  # noqa: F401
from server.core.mode import get_execution_mode
from server.db import repo
from server.db.base import Base, engine
from server.db.schemas import ProblemCatalogRead, ProblemRead, ProblemSummaryRead
from server.db.seed import seed_problems
from server.hints.engine import HintEngine
from server.hints.jailbreak import check_jailbreak, get_refusal
from server.llm_provider import get_provider
from server.sandbox.client import PistonClient
from server.sandbox.result_models import TestCaseResult, TestRunResult
from server.sandbox.runner import build_wrapper, extract_function_name, parse_result
from server.tool_models import ScaffoldFile, StartProblemResult
from server.workspace import (
    build_solution_scaffold_contents,
    scaffold_sha256,
    write_solution_scaffold,
)

load_dotenv()
mcp = FastMCP("interview-mcp")

_hint_engine: HintEngine | None = None
_piston_client: PistonClient | None = None
PYTHON_VERSION = "3.12.0"


def _get_hint_engine() -> HintEngine:
    global _hint_engine
    if _hint_engine is None:
        _hint_engine = HintEngine(get_provider())
    return _hint_engine


def _get_piston_client() -> PistonClient:
    global _piston_client
    if _piston_client is None:
        base_url = os.environ.get("PISTON_BASE_URL", "http://localhost:2000")
        _piston_client = PistonClient(base_url=base_url)
    return _piston_client


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
    problems = repo.list_problems()
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
    problems = repo.list_problems(difficulty=difficulty, tag=tag)
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

    problem = repo.get_problem(problem_id)
    if problem is None:
        raise ValueError(f"Problem '{problem_id}' not found.")

    starter_code = problem.starter_code.get(language)
    if starter_code is None:
        raise ValueError(
            f"No starter code for language '{language}' on problem '{problem_id}'. "
            f"Available: {sorted(problem.starter_code.keys())}"
        )

    attempt = repo.create_attempt(problem_id=problem.id, language=language)
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
    attempt = repo.get_attempt(attempt_id)
    if attempt is None:
        return f"Attempt {attempt_id!r} not found. Call start_problem first."

    problem = repo.get_problem(attempt.problem_id)
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


def _test_input_as_list(value: object) -> list[object]:
    if not isinstance(value, Sequence) or isinstance(value, str | bytes):
        raise ValueError("Test case input must be a list of function arguments.")
    return list(value)


@mcp.tool
def run_tests(attempt_id: str, code: str) -> TestRunResult:
    """Run an attempt's tests against provided solution code.

    Args:
        attempt_id: Identifier returned by start_problem.
        code: Full contents of the user's solution file.
    """
    attempt = repo.get_attempt(attempt_id)
    if attempt is None:
        raise ValueError(f"Attempt {attempt_id!r} not found. Call start_problem first.")

    problem = repo.get_problem(attempt.problem_id)
    if problem is None:
        raise ValueError(f"Problem {attempt.problem_id!r} not found in database.")

    if attempt.language != "python":
        raise ValueError(
            f"run_tests currently supports Python only. Attempt language is {attempt.language!r}."
        )

    user_code = code.strip()
    if not user_code:
        raise ValueError("code argument is empty. Pass the contents of solution.py.")

    function_name = extract_function_name(problem.starter_code["python"])
    test_cases = problem.test_cases.get("python", [])
    client = _get_piston_client()

    case_results: list[TestCaseResult] = []
    for index, test_case in enumerate(test_cases):
        test_input = _test_input_as_list(test_case["input"])
        expected = test_case["expected"]
        wrapper = build_wrapper(
            user_code=user_code,
            function_name=function_name,
            test_input=test_input,
        )
        execution = client.execute(
            language="python",
            version=PYTHON_VERSION,
            code=wrapper,
        )

        if execution.transport_error:
            case_results.append(
                TestCaseResult(
                    index=index,
                    passed=False,
                    input=test_input,
                    expected=expected,
                    error=execution.transport_error,
                    wall_time_ms=execution.wall_time_ms,
                )
            )
            continue

        if execution.timed_out:
            case_results.append(
                TestCaseResult(
                    index=index,
                    passed=False,
                    input=test_input,
                    expected=expected,
                    user_stderr=execution.stderr,
                    error=f"timed out after {execution.wall_time_ms}ms",
                    wall_time_ms=execution.wall_time_ms,
                )
            )
            continue

        user_stdout, actual, parse_error = parse_result(execution.stdout)
        if parse_error is not None:
            case_results.append(
                TestCaseResult(
                    index=index,
                    passed=False,
                    input=test_input,
                    expected=expected,
                    user_stdout=user_stdout,
                    user_stderr=execution.stderr,
                    error=parse_error,
                    wall_time_ms=execution.wall_time_ms,
                )
            )
            continue

        case_results.append(
            TestCaseResult(
                index=index,
                passed=actual == expected,
                input=test_input,
                expected=expected,
                actual=actual,
                user_stdout=user_stdout,
                user_stderr=execution.stderr,
                wall_time_ms=execution.wall_time_ms,
            )
        )

    tests_passed = sum(1 for result in case_results if result.passed)
    run_result = TestRunResult(
        attempt_id=attempt.id,
        problem_id=problem.id,
        tests_total=len(case_results),
        tests_passed=tests_passed,
        tests=case_results,
        all_passed=tests_passed == len(case_results) and len(case_results) > 0,
    )

    repo.record_event(
        attempt_id=attempt.id,
        kind="test_run",
        payload={
            "tests_total": run_result.tests_total,
            "tests_passed": run_result.tests_passed,
            "all_passed": run_result.all_passed,
        },
    )

    return run_result


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
        repo.record_event(
            attempt_id="unknown",
            kind="jailbreak_blocked",
            payload={"pattern": pattern_name, "source": "current_code"},
        )
        return HintResult(hint=get_refusal(), depth=depth, used_fallback=False)

    attempt = repo.get_active_attempt()
    if attempt is None:
        raise ValueError("No active problem. Call start_problem first.")

    problem = repo.get_problem(attempt.problem_id)
    if problem is None:
        raise ValueError(f"Problem '{attempt.problem_id}' not found in database.")

    engine_instance = _get_hint_engine()
    hint, metadata = engine_instance.generate_hint(
        attempt=attempt,
        problem=problem,
        current_code=current_code,
        depth=depth,
    )

    repo.record_event(
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
