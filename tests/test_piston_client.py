"""Unit tests for the Piston HTTP client."""

from __future__ import annotations

import json

import httpx

from server.sandbox.client import ExecutionResult, PistonClient


def _make_client(transport: httpx.MockTransport) -> PistonClient:
    return PistonClient(base_url="http://test.local", transport=transport)


def test_happy_path_normal_execution() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v2/execute"
        return httpx.Response(
            200,
            json={
                "run": {
                    "stdout": "2\n",
                    "stderr": "",
                    "code": 0,
                    "signal": None,
                    "wall_time": 42,
                }
            },
        )

    client = _make_client(httpx.MockTransport(handler))
    result = client.execute(language="python", version="3.12.0", code="print(1+1)")

    assert result.stdout == "2\n"
    assert result.stderr == ""
    assert result.exit_code == 0
    assert result.timed_out is False
    assert result.wall_time_ms == 42
    assert result.transport_error is None


def test_exit_code_zero_stays_zero() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "run": {
                    "stdout": "",
                    "stderr": "",
                    "code": 0,
                    "signal": None,
                    "wall_time": 1,
                }
            },
        )

    result = _make_client(httpx.MockTransport(handler)).execute(
        language="python",
        version="3.12.0",
        code="pass",
    )
    assert result.exit_code == 0


def test_user_code_runtime_error_is_not_transport_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "run": {
                    "stdout": "",
                    "stderr": "ZeroDivisionError: division by zero\n",
                    "code": 1,
                    "signal": None,
                    "wall_time": 7,
                }
            },
        )

    result = _make_client(httpx.MockTransport(handler)).execute(
        language="python",
        version="3.12.0",
        code="1/0",
    )

    assert result.exit_code == 1
    assert "ZeroDivisionError" in result.stderr
    assert result.transport_error is None
    assert result.timed_out is False


def test_timeout_surfaces_as_timed_out() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "run": {
                    "stdout": "",
                    "stderr": "",
                    "code": -1,
                    "signal": "SIGKILL",
                    "wall_time": 5000,
                }
            },
        )

    result = _make_client(httpx.MockTransport(handler)).execute(
        language="python",
        version="3.12.0",
        code="while True: pass",
    )

    assert result.timed_out is True


def test_network_unreachable_surfaces_as_transport_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    result = _make_client(httpx.MockTransport(handler)).execute(
        language="python",
        version="3.12.0",
        code="print(1)",
    )

    assert result.transport_error is not None
    assert "piston unreachable" in result.transport_error
    assert result.exit_code == -1


def test_piston_5xx_surfaces_as_transport_error() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="upstream busy")

    result = _make_client(httpx.MockTransport(handler)).execute(
        language="python",
        version="3.12.0",
        code="print(1)",
    )

    assert result.transport_error is not None
    assert "piston server error" in result.transport_error


def test_piston_4xx_surfaces_as_transport_error_with_body() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="unknown language")

    result = _make_client(httpx.MockTransport(handler)).execute(
        language="cobol",
        version="x.y.z",
        code="hello",
    )

    assert result.transport_error is not None
    assert "rejected request" in result.transport_error
    assert "unknown language" in result.stderr


def test_request_payload_shape() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "run": {
                    "stdout": "",
                    "stderr": "",
                    "code": 0,
                    "signal": None,
                    "wall_time": 0,
                }
            },
        )

    _make_client(httpx.MockTransport(handler)).execute(
        language="python",
        version="3.12.0",
        code="print(1)",
        stdin="42\n",
        run_timeout_ms=3000,
    )

    assert captured["language"] == "python"
    assert captured["version"] == "3.12.0"
    assert captured["stdin"] == "42\n"
    assert captured["run_timeout"] == 3000
    assert captured["files"] == [{"content": "print(1)"}]


def test_default_run_timeout_matches_piston_limit() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "run": {
                    "stdout": "",
                    "stderr": "",
                    "code": 0,
                    "signal": None,
                    "wall_time": 0,
                }
            },
        )

    _make_client(httpx.MockTransport(handler)).execute(
        language="python",
        version="3.12.0",
        code="print(1)",
    )

    assert captured["run_timeout"] == 3000


def test_execution_result_is_pydantic() -> None:
    result = ExecutionResult(
        stdout="hi",
        stderr="",
        exit_code=0,
        timed_out=False,
        wall_time_ms=10,
    )
    assert result.model_dump()["stdout"] == "hi"
