"""
Piston HTTP client.

This module owns only the transport boundary: send one source file to Piston's
execute endpoint and normalize the nested response into a flat result model.
"""

from __future__ import annotations

import httpx
from pydantic import BaseModel


class ExecutionResult(BaseModel):
    """Flat execution result independent of Piston's nested JSON shape."""

    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool
    wall_time_ms: int
    transport_error: str | None = None


class PistonClient:
    """HTTP wrapper over Piston's /api/v2/execute endpoint."""

    def __init__(
        self,
        base_url: str = "http://localhost:2000",
        *,
        timeout_s: float = 10.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.Client(timeout=timeout_s, transport=transport)

    def execute(
        self,
        *,
        language: str,
        version: str,
        code: str,
        stdin: str = "",
        run_timeout_ms: int = 5_000,
        memory_limit_bytes: int = 256 * 1024 * 1024,
    ) -> ExecutionResult:
        """Execute a single file of code in Piston."""
        payload = {
            "language": language,
            "version": version,
            "stdin": stdin,
            "run_timeout": run_timeout_ms,
            "run_memory_limit": memory_limit_bytes,
            "files": [{"content": code}],
        }

        try:
            response = self._client.post(
                f"{self._base_url}/api/v2/execute",
                json=payload,
            )
        except httpx.RequestError as exc:
            return ExecutionResult(
                stdout="",
                stderr="",
                exit_code=-1,
                timed_out=False,
                wall_time_ms=0,
                transport_error=f"piston unreachable: {exc}",
            )

        if response.status_code >= 500:
            return ExecutionResult(
                stdout="",
                stderr=response.text,
                exit_code=-1,
                timed_out=False,
                wall_time_ms=0,
                transport_error=f"piston server error: {response.status_code}",
            )

        if response.status_code >= 400:
            return ExecutionResult(
                stdout="",
                stderr=response.text,
                exit_code=-1,
                timed_out=False,
                wall_time_ms=0,
                transport_error=f"piston rejected request: {response.status_code}",
            )

        body = response.json()
        run = body.get("run", {})
        raw_code = run.get("code")
        exit_code = int(raw_code) if raw_code is not None else -1

        return ExecutionResult(
            stdout=run.get("stdout", ""),
            stderr=run.get("stderr", ""),
            exit_code=exit_code,
            timed_out=run.get("signal") == "SIGKILL",
            wall_time_ms=int(run.get("wall_time", 0) or 0),
        )

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()
