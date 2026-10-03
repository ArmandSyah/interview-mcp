"""ASGI factory and transport guards for remote deployments."""

from __future__ import annotations

import os

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class RequestGuard:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.origins = {
            value.strip()
            for value in os.environ.get("INTERVIEW_MCP_ALLOWED_ORIGINS", "").split(",")
            if value.strip()
        }

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        origin = request.headers.get("origin")
        if origin and origin not in self.origins:
            await PlainTextResponse("Origin not allowed", status_code=403)(scope, receive, send)
            return
        # Buffer at most 1 MiB, including bodies without Content-Length.
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > 1024 * 1024:
                await PlainTextResponse("Request too large", status_code=413)(scope, receive, send)
                return
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay() -> Message:
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


def remote_middleware() -> list[Middleware]:
    hosts = [
        value.strip()
        for value in os.environ.get(
            "INTERVIEW_MCP_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]"
        ).split(",")
        if value.strip()
    ]
    if not hosts or "*" in hosts:
        raise ValueError("Set INTERVIEW_MCP_ALLOWED_HOSTS to explicit server hostnames.")
    return [Middleware(TrustedHostMiddleware, allowed_hosts=hosts), Middleware(RequestGuard)]


def create_app() -> Starlette:
    from server.main import configure_remote, mcp

    configure_remote()
    return mcp.http_app(
        path="/mcp", stateless_http=True, json_response=True, middleware=remote_middleware()
    )
