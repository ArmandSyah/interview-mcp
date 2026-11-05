"""Local AgentCore HTTP contract exercise. This is not a hosted deployment entrypoint."""

import argparse
import asyncio
import hmac
import os
from collections.abc import Callable
from pathlib import Path
from threading import Lock
from uuid import UUID

import httpx
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

from coach import CoachTurn, Target, check_downloaded_model, local_model, server_client

SESSION_HEADER = b"x-amzn-bedrock-agentcore-runtime-session-id"


class Prompt(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    prompt: str = Field(min_length=1, max_length=8000)


class LocalAccess:
    """Authenticate one local operator and bind every request to one configured session."""

    def __init__(self, app, *, token: str, session_id: str):
        self.app = app
        self.authorization = f"Bearer {token}".encode("ascii")
        self.session_id = session_id.encode("ascii")
        self.busy = Lock()

    async def __call__(self, scope, receive, send):
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def reject(status, error):
            await JSONResponse({"error": error}, status_code=status)(scope, receive, send)

        headers = scope["headers"]

        def values(key):
            return [value for name, value in headers if name.lower() == key]

        if values(b"host") not in ([b"127.0.0.1:8080"], [b"localhost:8080"]):
            await reject(403, "local_host_required")
            return
        if values(b"origin"):
            await reject(403, "browser_origin_not_allowed")
            return
        if scope["path"] == "/ping" and scope["method"] == "GET":
            await self.app(scope, receive, send)
            return
        if scope["path"] != "/invocations" or scope["method"] != "POST":
            await reject(404, "not_found")
            return
        auth = values(b"authorization")
        if len(auth) != 1 or not hmac.compare_digest(auth[0], self.authorization):
            await reject(401, "local_credential_required")
            return
        if values(SESSION_HEADER) != [self.session_id]:
            await reject(403, "configured_session_required")
            return
        if values(b"content-type") != [b"application/json"]:
            await reject(415, "json_required")
            return
        if not self.busy.acquire(blocking=False):
            await reject(409, "turn_in_progress")
            return
        try:
            body = bytearray()
            try:
                async with asyncio.timeout(5):
                    while True:
                        message = await receive()
                        if message["type"] == "http.disconnect":
                            return
                        body.extend(message.get("body", b""))
                        if len(body) > 40_000:
                            await reject(413, "request_too_large")
                            return
                        if not message.get("more_body"):
                            break
            except TimeoutError:
                await reject(408, "request_timeout")
                return

            # Credentials, identity claims, tracing baggage, and AWS headers never enter the SDK.
            scope = dict(
                scope,
                headers=[
                    (b"content-type", b"application/json"),
                    (SESSION_HEADER, self.session_id),
                ],
            )
            delivered = False

            async def replay_body():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}
                await asyncio.Event().wait()

            async def disconnected():
                while (await receive())["type"] != "http.disconnect":
                    pass

            invocation = asyncio.create_task(self.app(scope, replay_body, send))
            disconnect = asyncio.create_task(disconnected())
            try:
                done, _ = await asyncio.wait(
                    [invocation, disconnect],
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if invocation in done:
                    await invocation
            finally:
                invocation.cancel()
                disconnect.cancel()
                await asyncio.gather(invocation, disconnect, return_exceptions=True)
        finally:
            self.busy.release()


def make_app(token: str, session_id: str, turn_factory: Callable[[], CoachTurn]):
    """Build the SDK app without an AWS client, model selection, or remote MCP endpoint."""
    if not 32 <= len(token) <= 128 or not token.isascii() or any(c.isspace() for c in token):
        raise ValueError("Use a random local credential with 32 to 128 ASCII characters.")
    if str(UUID(session_id)) != session_id:
        raise ValueError("Use a canonical session UUID.")
    app = BedrockAgentCoreApp(debug=False)

    @app.entrypoint
    async def invoke(payload):
        try:
            request = Prompt.model_validate(payload)
            if not request.prompt.strip():
                raise ValueError
        except (ValidationError, ValueError):
            raise HTTPException(400, "prompt_only_required") from None
        try:
            hint = await turn_factory().run(request.prompt)
        except TimeoutError:
            raise HTTPException(504, "coaching_timeout") from None
        except Exception:  # noqa: BLE001 - redact failures at this HTTP boundary.
            # Do not return provider errors, tool evidence, credentials, or internal paths.
            raise HTTPException(503, "no_valid_hint") from None
        return {"hint": hint, "mode": "local-contract-only"}

    app.add_middleware(LocalAccess, token=token, session_id=session_id)
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--server-python", type=Path, required=True)
    parser.add_argument("--db-dir", type=Path, required=True)
    parser.add_argument("--attempt-id")
    parser.add_argument("--session-id")
    parser.add_argument("--checkpoint-id")
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    token = os.environ.get("COACH_LOCAL_TOKEN", "")
    runtime_session = os.environ.get("COACH_LOCAL_SESSION", "")
    target = Target(args.attempt_id, args.session_id, args.checkpoint_id)
    model = local_model(args.model)
    app = make_app(token, runtime_session, lambda: CoachTurn(mcp, target, model))
    with httpx.Client(timeout=5, trust_env=False, follow_redirects=False) as client:
        check_downloaded_model(args.model, client)
    # Start-up configuration owns this one local target. Request JSON cannot replace it.
    with server_client(args.repo, args.server_python, args.db_dir) as mcp:
        app.run(host="127.0.0.1", port=8080, proxy_headers=False)


if __name__ == "__main__":
    main()
