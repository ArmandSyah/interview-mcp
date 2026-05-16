# server/main.py
from dotenv import load_dotenv
from fastmcp import FastMCP

import server.db.models  # noqa: F401
from server.db.base import Base, engine
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


if __name__ == "__main__":
    on_startup()
    mcp.run()
