"""Exercise the checked-in VS Code launch command with isolated practice data."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from fastmcp import Client
from fastmcp.client.transports import StdioTransport


def test_vscode_launch_returns_catalog_and_keeps_solution_files(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[1]
    config = json.loads((root / ".vscode/mcp.json").read_text())["servers"]["interview"]

    def expand(value: str) -> str:
        return value.replace("${workspaceFolder}", str(root))

    assert config["type"] == "stdio"
    assert config["env"]["INTERVIEW_MCP_MODE"] == "remote"
    assert config["env"]["LLM_PROVIDER"] == "fallback"
    assert config["env"]["INTERVIEW_MCP_DB_DIR"] == "${workspaceFolder}/.interview-mcp-vscode"
    environment = {key: expand(value) for key, value in config["env"].items()}
    environment["INTERVIEW_MCP_DB_DIR"] = str(tmp_path / "database")
    environment["UV_CACHE_DIR"] = os.environ.get("UV_CACHE_DIR", str(tmp_path / "uv-cache"))
    environment["UV_OFFLINE"] = "1"
    transport = StdioTransport(
        command=config["command"],
        args=[expand(value) for value in config["args"]],
        cwd=expand(config["cwd"]),
        env=environment,
    )
    sentinel = root / "0015-delivery-hold-clusters/solution.py"
    original = sentinel.read_bytes() if sentinel.exists() else None

    async def scenario() -> None:
        async with Client(transport, timeout=20, init_timeout=20) as client:
            assert (await client.call_tool("ping", {})).data == "pong"
            catalog = await client.call_tool("list_problems", {})
            assert len(catalog.data) == 5
            result = await client.call_tool(
                "start_problem", {"problem_id": "0015-delivery-hold-clusters"}
            )
            assert result.data.mode == "remote"
            assert result.data.files_written == []
            assert result.data.files_to_create
            hint = await client.call_tool(
                "get_hint",
                {"attempt_id": result.data.attempt_id, "current_code": "", "depth": 1},
            )
            assert hint.data.used_fallback
            assert len(hint.data.hint) > 10
            assert len((await client.call_tool("list_design_problems", {})).data) == 5

    asyncio.run(scenario())
    assert (sentinel.read_bytes() if sentinel.exists() else None) == original
    assert (tmp_path / "database/interview_mcp.sqlite").is_file()
