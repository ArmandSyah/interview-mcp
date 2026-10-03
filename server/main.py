# server/main.py
import argparse
import os
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
import httpx
from fastmcp import FastMCP
from pydantic import BaseModel
from sqlalchemy import func, select
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse

import server.config
import server.db.models  # noqa: F401
from server.auth import DatabaseTokenVerifier
from server.core.limits import ToolLimits
from server.core.mode import get_execution_mode
from server.db import repo
from server.db.base import get_session, initialize_database
from server.db.models import Problem
from server.db.schemas import ProblemCatalogRead, ProblemRead, ProblemSummaryRead
from server.db.seed import seed_problems
from server.hints.engine import HintEngine
from server.hints.jailbreak import check_jailbreak, get_refusal
from server.llm_provider import get_provider
from server.sandbox.client import PistonClient
from server.sandbox.result_models import SubmissionResult, TestCaseResult, TestRunResult
from server.sandbox.runner import build_wrapper, extract_function_name, parse_result
from server.tool_models import ScaffoldFile, StartProblemResult
from server.workspace import (
    build_solution_scaffold_contents,
    scaffold_sha256,
    write_solution_scaffold,
)


@asynccontextmanager
async def lifespan(server: FastMCP) -> AsyncIterator[None]:
    await anyio.to_thread.run_sync(on_startup)
    try:
        yield
    finally:
        global _piston_client
        if _piston_client is not None:
            _piston_client.close()
            _piston_client = None


mcp = FastMCP(
    "interview-mcp",
    version="0.2.0",
    instructions=(
        "Coach the user through coding interview practice. List problems, start one, "
        "and use the returned attempt_id in later calls. In remote mode, create the returned "
        "scaffold in the user's workspace. Give hints progressively "
        "and never reveal a full solution."
    ),
    lifespan=lifespan,
    middleware=[ToolLimits()],
)

_hint_engine: HintEngine | None = None
_piston_client: PistonClient | None = None
_followup_prompt: str | None = None
_FOLLOWUP_PROMPT_PATH = Path(__file__).parent / "hints" / "followup_prompt.txt"
PYTHON_VERSION = os.environ.get("INTERVIEW_MCP_PYTHON_VERSION", "3.12.0")


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


def _get_followup_prompt() -> str:
    global _followup_prompt
    if _followup_prompt is None:
        _followup_prompt = _FOLLOWUP_PROMPT_PATH.read_text(encoding="utf-8").strip()
    return _followup_prompt


def on_startup() -> None:
    initialize_database()
    seed_problems(strict=get_execution_mode() == "remote")


def configure_remote() -> None:
    os.environ["INTERVIEW_MCP_MODE"] = "remote"
    mcp.auth = DatabaseTokenVerifier()


if get_execution_mode() == "remote":
    configure_remote()


@mcp.custom_route("/", methods=["GET"])
async def landing_page(request: Request) -> HTMLResponse:
    return HTMLResponse(
        "<!doctype html><html lang='en'><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        "<title>Interview MCP</title><main><h1>Interview MCP</h1>"
        "<p>Practice Python coding interviews in your MCP-compatible editor. "
        "Browse problems, get progressive hints, run sandboxed tests, and track progress.</p>"
        "<p>Connect using Streamable HTTP at <code>/mcp</code> with your personal bearer key. "
        "The operator issues access keys; the hosted service requires one.</p>"
        "<p><a href='https://github.com/ArmandSyah/interview-mcp'>Setup and access instructions</a>"
        "</p></main></html>"
    )


@mcp.custom_route("/health", methods=["GET"])
async def health(request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok", "service": "interview-mcp", "version": "0.2.0"})


@mcp.custom_route("/ready", methods=["GET"])
async def ready(request: Request) -> JSONResponse:
    def problem_count() -> int:
        with get_session() as session:
            return (
                session.scalar(
                    select(func.count()).select_from(Problem).where(Problem.available.is_(True))
                )
                or 0
            )

    try:
        count = await anyio.to_thread.run_sync(problem_count)
        async with httpx.AsyncClient(timeout=3) as client:
            response = await client.get(
                os.environ.get("PISTON_BASE_URL", "http://localhost:2000").rstrip("/")
                + "/api/v2/runtimes"
            )
            response.raise_for_status()
            python_ready = any(
                runtime.get("language") == "python" and runtime.get("version") == PYTHON_VERSION
                for runtime in response.json()
            )
        healthy = count > 0 and python_ready
        return JSONResponse(
            {"ready": healthy, "problem_count": count, "python_ready": python_ready},
            status_code=200 if healthy else 503,
        )
    except Exception:
        return JSONResponse({"ready": False}, status_code=503)


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

    problem = repo.get_problem(problem_id, available_only=True)
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
    if len(code.encode("utf-8")) > 100_000:
        raise ValueError("Solution code must be at most 100 KB.")

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
                passed=actual == expected and execution.exit_code == 0,
                input=test_input,
                expected=expected,
                actual=actual,
                user_stdout=user_stdout,
                user_stderr=execution.stderr,
                error=(
                    f"sandbox exited with code {execution.exit_code}"
                    if execution.exit_code != 0
                    else None
                ),
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


def _fallback_followup_questions() -> str:
    return (
        "1. What is the time and space complexity of your solution, and which input "
        "size drives that cost?\n"
        "2. What edge case or changed constraint would make you reconsider this approach?"
    )


def _build_followup_user_message(*, problem: ProblemRead, code: str) -> str:
    return f'''Problem: {problem.title}

Description:
{problem.description_md}

Candidate's solution:
"""
{code}
"""

Ask exactly 2 follow-up questions.'''


@mcp.tool
def submit_solution(attempt_id: str, code: str) -> SubmissionResult:
    """Submit a solution and return interviewer-style follow-up questions.

    Args:
        attempt_id: Identifier returned by start_problem.
        code: Full contents of the user's solution file.
    """
    test_run = run_tests(attempt_id, code)
    if not test_run.all_passed:
        return SubmissionResult(
            completed=False,
            test_run=test_run,
            message=(
                f"{test_run.tests_passed}/{test_run.tests_total} tests passed. "
                "Keep iterating; review the failures and try again."
            ),
        )

    attempt = repo.get_attempt(attempt_id)
    if attempt is None:
        raise ValueError(f"Attempt {attempt_id!r} not found. Call start_problem first.")

    problem = repo.get_problem(attempt.problem_id)
    if problem is None:
        raise ValueError(f"Problem {attempt.problem_id!r} not found in database.")

    try:
        followups = get_provider().generate(
            system=_get_followup_prompt(),
            user=_build_followup_user_message(problem=problem, code=code),
            max_tokens=300,
        )
    except Exception:
        followups = _fallback_followup_questions()

    repo.mark_completed(attempt.id)
    repo.record_event(
        attempt_id=attempt.id,
        kind="submission",
        payload={
            "tests_passed": test_run.tests_passed,
            "tests_total": test_run.tests_total,
        },
    )

    return SubmissionResult(
        completed=True,
        test_run=test_run,
        followup_questions=followups,
        message="All tests passed. Attempt completed.",
    )


@mcp.tool
def get_progress(limit: int = 50) -> str:
    """Show recent attempts and their status as a Markdown table."""
    rows = repo.list_attempts_with_problems(limit=limit)
    if not rows:
        return "No attempts yet. Call `start_problem` to begin."

    lines = [
        "| Date | Problem | Difficulty | Status |",
        "|---|---|---|---|",
    ]
    completed = 0
    in_progress = 0

    for row in rows:
        started_at = row.attempt.started_at.strftime("%Y-%m-%d")
        status = row.attempt.status
        lines.append(
            f"| {started_at} | {row.problem_title} | {row.problem_difficulty} | {status} |"
        )
        if status == "completed":
            completed += 1
        elif status == "in_progress":
            in_progress += 1

    lines.append("")
    lines.append(
        f"**Summary:** {completed} completed, {in_progress} in progress, {len(rows)} total."
    )
    return "\n".join(lines)


class HintResult(BaseModel):
    hint: str
    depth: int
    used_fallback: bool


@mcp.tool
def get_hint(current_code: str, depth: int = 1, attempt_id: str | None = None) -> HintResult:
    """Get a hint for the active problem.

    Call this when you want a nudge without seeing the solution.
    Depth controls how much is revealed: 1 = conceptual nudge,
    2 = names the relevant pattern or data structure,
    3 = describes the algorithm in natural language.

    Args:
        current_code: Your current solution attempt. Pass the full file contents.
        depth: Hint depth 1-3. Start at 1, increase only if stuck.
        attempt_id: The attempt to coach. If omitted, use this user's active attempt.
    """
    if len(current_code.encode("utf-8")) > 100_000:
        raise ValueError("Solution code must be at most 100 KB.")
    depth = max(1, min(3, depth))
    attempt = repo.get_attempt(attempt_id) if attempt_id else repo.get_active_attempt()
    if attempt is None:
        raise ValueError("No active problem or attempt not found. Call start_problem first.")

    is_jailbreak, pattern_name = check_jailbreak(current_code)
    if is_jailbreak:
        repo.record_event(
            attempt_id=attempt.id,
            kind="jailbreak_blocked",
            payload={"pattern": pattern_name, "source": "current_code"},
        )
        return HintResult(hint=get_refusal(), depth=depth, used_fallback=False)

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


def main() -> None:
    parser = argparse.ArgumentParser(description="Coding interview practice MCP server.")
    parser.add_argument(
        "--remote", action="store_true", help="Serve authenticated Streamable HTTP."
    )
    parser.add_argument("--host", default=os.environ.get("INTERVIEW_MCP_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    args = parser.parse_args()
    if args.remote or get_execution_mode() == "remote":
        from server.http import remote_middleware

        configure_remote()
        mcp.run(
            transport="http",
            host=args.host,
            port=args.port,
            path="/mcp",
            stateless_http=True,
            json_response=True,
            middleware=remote_middleware(),
        )
    else:
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
