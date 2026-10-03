"""Resolve identity from verified MCP authentication, never tool arguments."""

from fastmcp.server.dependencies import get_access_token


def current_user_id() -> str:
    token = get_access_token()
    return token.client_id if token is not None else "local"
