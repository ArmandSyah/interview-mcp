from fastmcp import FastMCP

mcp = FastMCP("interview-mcp")


@mcp.tool
def ping() -> str:
    """Health check. Returns 'pong'."""
    return "pong"


if __name__ == "__main__":
    mcp.run()  # defaults to stdio transport
