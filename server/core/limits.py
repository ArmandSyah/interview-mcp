"""Bound concurrent expensive operations and per-user remote request volume."""

from __future__ import annotations

import asyncio

from fastmcp.exceptions import ToolError
from fastmcp.server.middleware import CallNext, Middleware, MiddlewareContext
from fastmcp.server.middleware.rate_limiting import SlidingWindowRateLimiter
from fastmcp.tools.base import ToolResult
from mcp.types import CallToolRequestParams

from server.core.identity import current_user_id
from server.core.mode import get_execution_mode


class ToolLimits(Middleware):
    def __init__(self) -> None:
        self._slots = asyncio.Semaphore(4)
        self._active_users: set[str] = set()
        self._limits: dict[str, SlidingWindowRateLimiter] = {}

    async def on_call_tool(
        self,
        context: MiddlewareContext[CallToolRequestParams],
        call_next: CallNext[CallToolRequestParams, ToolResult],
    ) -> ToolResult:
        if get_execution_mode() == "local":
            return await call_next(context)
        user_id = current_user_id()
        limiter = self._limits.setdefault(user_id, SlidingWindowRateLimiter(60, 60))
        if not await limiter.is_allowed():
            raise ToolError("Request limit reached. Try again in a minute.")
        if context.message.name not in {"get_hint", "run_tests", "submit_solution"}:
            return await call_next(context)
        if user_id in self._active_users or self._slots.locked():
            raise ToolError(
                "An execution is already running or the server is busy. Try again shortly."
            )
        async with self._slots:
            self._active_users.add(user_id)
            try:
                return await call_next(context)
            finally:
                self._active_users.remove(user_id)
