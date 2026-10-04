"""Private stdio sidecar for the desktop client; never opens a network listener.

Use artifact-only scaffolds, strict corpus loading and a desktop-owned database.
Authentication is unnecessary on this parent/child pipe (not a public transport).
The desktop main process owns all filesystem writes.
"""

import os


def main() -> None:
    os.environ["INTERVIEW_MCP_MODE"] = "remote"
    os.environ.setdefault("LLM_PROVIDER", "fallback")
    from server.main import mcp

    mcp.auth = None
    mcp.run(transport="stdio", show_banner=False)


if __name__ == "__main__":
    main()
