# server/main.py
from dotenv import load_dotenv
from fastmcp import FastMCP

import server.db.models  # noqa: F401
from server.db.base import Base, engine
from server.db.repo import list_problems as db_list_problems
from server.db.schemas import ProblemCatalogRead, ProblemSummaryRead
from server.db.seed import seed_problems

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


if __name__ == "__main__":
    on_startup()
    mcp.run()
