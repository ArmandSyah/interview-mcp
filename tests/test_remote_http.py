"""Exercise real MCP Streamable HTTP framing, authentication and tenant boundaries."""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport
from fastmcp.exceptions import ToolError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from server import main
from server.auth import create_key, key_hash, revoke_key
from server.db import base, seed
from server.db.models import ApiKey
from server.http import create_app


@pytest.fixture
def remote_app(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'test.sqlite'}")
    monkeypatch.setattr(base, "engine", engine)
    monkeypatch.setattr(base, "SessionLocal", sessionmaker(bind=engine))
    monkeypatch.setattr(seed, "PROBLEMS_DIR", Path(__file__).parents[1] / "problems/examples")
    monkeypatch.setattr(main.mcp, "auth", main.mcp.auth)
    monkeypatch.setattr(main, "_hint_engine", None)
    monkeypatch.setenv("INTERVIEW_MCP_MODE", "remote")
    monkeypatch.setenv("LLM_PROVIDER", "fallback")
    monkeypatch.setenv("INTERVIEW_MCP_ALLOWED_HOSTS", "localhost")
    monkeypatch.chdir(tmp_path)
    base.initialize_database()
    app = create_app()
    yield app
    engine.dispose()


def _client(app, token: str) -> Client:
    def factory(headers=None, timeout=None, auth=None, **kwargs) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            headers=headers,
            timeout=timeout,
            auth=auth,
            **kwargs,
        )

    return Client(
        StreamableHttpTransport("http://localhost/mcp", auth=token, httpx_client_factory=factory)
    )


def test_http_auth_and_request_guards(remote_app) -> None:
    async def scenario() -> None:
        async with (
            remote_app.router.lifespan_context(remote_app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=remote_app), base_url="http://localhost"
            ) as client,
        ):
            assert (await asyncio.wait_for(client.get("/health"), 2)).status_code == 200
            assert "Interview MCP" in (await asyncio.wait_for(client.get("/"), 2)).text
            assert (await client.post("/mcp", json={})).status_code == 401
            assert (
                await client.post("/mcp", json={}, headers={"Authorization": "Bearer invalid"})
            ).status_code == 401
            assert (
                await client.post("/mcp", json={}, headers={"Origin": "https://evil.invalid"})
            ).status_code == 403
            assert (
                await client.get("/health", headers={"Host": "evil.invalid"})
            ).status_code == 400
            assert (await client.post("/mcp", content=b"x" * (1024 * 1024 + 1))).status_code == 413

    asyncio.run(scenario())


def test_http_clients_isolate_attempts_hints_progress_and_revocation(remote_app, tmp_path) -> None:
    alice_key, bob_key = create_key("alice"), create_key("bob")
    with base.get_session() as session:
        stored = list(session.scalars(select(ApiKey)))
        assert {key.key_hash for key in stored} == {key_hash(alice_key), key_hash(bob_key)}

    async def scenario() -> None:
        async with (
            remote_app.router.lifespan_context(remote_app),
            _client(remote_app, alice_key) as alice,
            _client(remote_app, bob_key) as bob,
        ):
            tools = {tool.name for tool in await alice.list_tools()}
            assert {"start_problem", "get_hint", "run_tests", "submit_solution"} <= tools
            catalog = await alice.call_tool("list_problems", {})
            assert len(catalog.data) == 5
            alice_start = await alice.call_tool(
                "start_problem", {"problem_id": "0015-delivery-hold-clusters"}
            )
            bob_start = await bob.call_tool(
                "start_problem", {"problem_id": "0011-conveyor-permit-route"}
            )
            attempt_id = alice_start.data.attempt_id
            assert alice_start.data.mode == "remote"
            assert alice_start.data.files_to_create
            assert not alice_start.data.files_written
            assert not list(tmp_path.rglob("solution.py"))
            alice_hint = await alice.call_tool("get_hint", {"current_code": "", "depth": 1})
            bob_hint = await bob.call_tool("get_hint", {"current_code": "", "depth": 1})
            assert alice_hint.data.used_fallback and bob_hint.data.used_fallback
            assert alice_hint.data.hint != bob_hint.data.hint
            for tool, arguments in [
                ("get_hint", {"attempt_id": attempt_id, "current_code": ""}),
                ("run_tests", {"attempt_id": attempt_id, "code": "pass"}),
                ("submit_solution", {"attempt_id": attempt_id, "code": "pass"}),
            ]:
                with pytest.raises(ToolError):
                    await bob.call_tool(tool, arguments)
            description = await bob.call_tool("get_problem_description", {"attempt_id": attempt_id})
            assert "not found" in description.data
            alice_progress = (await alice.call_tool("get_progress", {})).data
            bob_progress = (await bob.call_tool("get_progress", {})).data
            assert "Delivery Hold" in alice_progress and "Conveyor Permit" not in alice_progress
            assert "Conveyor Permit" in bob_progress and "Delivery Hold" not in bob_progress
            assert bob_start.data.attempt_id != attempt_id
        # A new lifespan/client has no MCP session state but retains user progress.
        rotated_key = create_key("alice")
        assert revoke_key(key_hash(alice_key))
        async with remote_app.router.lifespan_context(remote_app):
            async with _client(remote_app, rotated_key) as alice:
                assert "Delivery Hold" in (await alice.call_tool("get_progress", {})).data
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=remote_app), base_url="http://localhost"
            ) as client:
                assert (
                    await client.post(
                        "/mcp", json={}, headers={"Authorization": f"Bearer {alice_key}"}
                    )
                ).status_code == 401

    asyncio.run(scenario())
