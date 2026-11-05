"""Real AgentCore HTTP lifecycle with Strands and scripted responses. No AWS or inference."""

import asyncio
import threading
from unittest.mock import AsyncMock

import httpx
import pytest

pytest.importorskip("bedrock_agentcore")

from bedrock_agentcore.runtime import BedrockAgentCoreContext
from test_coach import ATTEMPT, HINT, SESSION, ScriptedModel

from agentcore_local import SESSION_HEADER, make_app
from coach import CoachTurn, Target

TOKEN = "local-test-credential-" + "a" * 32
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    SESSION_HEADER.decode(): SESSION,
}


@pytest.fixture
def boundary():
    calls = []
    mcp = type(
        "Client",
        (),
        {
            "call_tool_async": AsyncMock(
                return_value={
                    "status": "success",
                    "content": [{"text": "Practice evidence."}],
                }
            )
        },
    )()

    def turn():
        result = CoachTurn(
            mcp,
            Target(attempt_id=ATTEMPT),
            ScriptedModel(
                [
                    [("read_context", {})],
                    [("publish_hint", {"hint": HINT})],
                ]
            ),
        )
        result.runtime_headers = BedrockAgentCoreContext.get_request_headers()
        calls.append(result)
        return result

    return make_app(TOKEN, SESSION, turn), mcp, calls


async def test_real_agentcore_entrypoint_uses_bounded_strands_loop(boundary):
    app, mcp, turns = boundary
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app),
            base_url="http://127.0.0.1:8080",
        ) as client,
    ):
        assert (await client.get("/ping")).status_code == 200
        for _ in range(2):
            response = await client.post(
                "/invocations",
                headers={**HEADERS, "X-Amzn-Bedrock-AgentCore-Runtime-Custom-Owner": "other"},
                json={"prompt": "Help."},
            )
            assert response.status_code == 200
            assert response.json() == {"hint": HINT, "mode": "local-contract-only"}
    assert len(turns) == 2
    assert all(turn.runtime_headers is None for turn in turns)
    assert all(turn.limits.models == 2 and turn.limits.tools == 2 for turn in turns)
    assert all(
        call.kwargs["arguments"] == {"attempt_id": ATTEMPT}
        for call in mcp.call_tool_async.call_args_list
    )


@pytest.mark.parametrize(
    "headers,payload,expected",
    [
        ({}, {"prompt": "Help."}, 401),
        ({**HEADERS, "Authorization": "Bearer wrong"}, {"prompt": "Help."}, 401),
        ({**HEADERS, SESSION_HEADER.decode(): ATTEMPT}, {"prompt": "Help."}, 403),
        ({**HEADERS, "Origin": "https://example.com"}, {"prompt": "Help."}, 403),
        ({**HEADERS, "Host": "attacker.example"}, {"prompt": "Help."}, 403),
        (HEADERS, {"prompt": "Help.", "owner_id": "other"}, 400),
        (HEADERS, {"prompt": "Help.", "attempt_id": SESSION}, 400),
        (HEADERS, {"prompt": "Help.", "mcp_url": "https://example.com"}, 400),
        (HEADERS, {"prompt": "Help.", "model": "bedrock"}, 400),
        (HEADERS, {"prompt": " "}, 400),
        (HEADERS, {"prompt": "x" * 8001}, 400),
        (HEADERS, {"prompt": "x" * 40001}, 413),
    ],
)
async def test_rejected_request_cannot_start_agent(boundary, headers, payload, expected):
    app, mcp, turns = boundary
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app),
            base_url="http://127.0.0.1:8080",
        ) as client,
    ):
        response = await client.post("/invocations", headers=headers, json=payload)
    assert response.status_code == expected
    assert turns == []
    mcp.call_tool_async.assert_not_awaited()


async def test_inference_failure_is_redacted(boundary, caplog):
    app, mcp, _ = boundary
    mcp.call_tool_async.side_effect = RuntimeError("private-provider-error")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app),
        base_url="http://127.0.0.1:8080",
    ) as client:
        response = await client.post("/invocations", headers=HEADERS, json={"prompt": "Help."})
    assert response.status_code == 503
    assert response.json() == {"error": "no_valid_hint"}
    assert TOKEN not in caplog.text


async def wait_flag(flag):
    async with asyncio.timeout(3):
        while not flag.is_set():
            await asyncio.sleep(0.005)


async def test_cancel_reaches_sdk_worker_and_releases_busy_turn(boundary):
    app, mcp, turns = boundary
    entered, stopped = threading.Event(), threading.Event()

    async def slow_read(**kwargs):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    mcp.call_tool_async.side_effect = slow_read
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app),
        base_url="http://127.0.0.1:8080",
    ) as client:
        request = asyncio.create_task(
            client.post(
                "/invocations",
                headers=HEADERS,
                json={"prompt": "Help."},
            )
        )
        await wait_flag(entered)
        blocked = await client.post("/invocations", headers=HEADERS, json={"prompt": "Again."})
        assert blocked.status_code == 409
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        await wait_flag(stopped)
        assert turns[0].hint is None
        assert turns[0].limits.models == 1
        mcp.call_tool_async.side_effect = None
        response = await client.post("/invocations", headers=HEADERS, json={"prompt": "Retry."})
        assert response.status_code == 200


def test_no_implicit_local_credential_or_session():
    for token, session in [("", SESSION), (TOKEN, ""), ("x" * 31, SESSION)]:
        with pytest.raises(ValueError):
            make_app(token, session, lambda: None)


async def test_http_disconnect_cancels_tool_before_next_model(boundary):
    app, mcp, turns = boundary
    entered, stopped = threading.Event(), threading.Event()

    async def slow_read(**kwargs):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    mcp.call_tool_async.side_effect = slow_read
    messages = asyncio.Queue()
    await messages.put({"type": "http.request", "body": b'{"prompt":"Help."}', "more_body": False})
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/invocations",
        "raw_path": b"/invocations",
        "query_string": b"",
        "root_path": "",
        "client": ("127.0.0.1", 12345),
        "server": ("127.0.0.1", 8080),
        "headers": [
            (b"host", b"127.0.0.1:8080"),
            (b"content-type", b"application/json"),
            (b"authorization", f"Bearer {TOKEN}".encode()),
            (SESSION_HEADER, SESSION.encode()),
        ],
    }
    sent = []

    async def send(message):
        sent.append(message)

    invocation = asyncio.create_task(app(scope, messages.get, send))
    await wait_flag(entered)
    await messages.put({"type": "http.disconnect"})
    await asyncio.wait_for(invocation, timeout=3)
    await wait_flag(stopped)
    assert sent == []
    assert turns[0].hint is None
    assert turns[0].limits.models == 1
    mcp.call_tool_async.assert_awaited_once()
