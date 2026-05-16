# server/main.py
from dotenv import load_dotenv
from fastmcp import FastMCP

import server.db.models  # noqa: F401
from server.db.base import Base, engine
from server.db.repo import (
    create_attempt as db_create_attempt,
)
from server.db.repo import (
    get_problem as db_get_problem,
)
from server.db.repo import (
    list_problems as db_list_problems,
)
from server.db.schemas import AttemptRead, ProblemCatalogRead, ProblemSummaryRead
from server.db.seed import seed_problems
from server.workspace import write_active_problem

load_dotenv()
mcp = FastMCP("interview-mcp")


def on_startup() -> None:
    Base.metadata.create_all(engine)
    seed_problems()


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


if __name__ == "__main__":
    on_startup()
    mcp.run()
