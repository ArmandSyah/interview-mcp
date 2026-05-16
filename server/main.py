from dotenv import load_dotenv
from fastmcp import FastMCP

load_dotenv()  # loads .env into os.environ before anything else runs
mcp = FastMCP("interview-mcp")


@mcp.tool
def ping() -> str:
    """Health check. Returns 'pong'."""
    return "pong"


if __name__ == "__main__":
    mcp.run()  # defaults to stdio transport
