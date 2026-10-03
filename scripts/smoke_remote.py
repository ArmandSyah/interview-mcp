"""Verify an actual hosted MCP service. Keys come from environment, never CLI arguments."""

from __future__ import annotations

import argparse
import asyncio
import os
from urllib.parse import urlsplit

import httpx
from fastmcp import Client

SOLUTION = """def merge_delivery_holds(holds, grace_days):
    merged = []
    for start, end in sorted(holds):
        if merged and start - merged[-1][1] <= grace_days:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return merged
"""


async def check(url: str, expected_problems: int | None, check_only: bool) -> None:
    token = os.environ.get("INTERVIEW_MCP_API_KEY")
    if not token:
        raise SystemExit("Set INTERVIEW_MCP_API_KEY to a dedicated smoke-test user's key.")
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.path != "/mcp":
        raise SystemExit("Supply a Streamable HTTP URL ending in /mcp.")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    async with httpx.AsyncClient(timeout=10) as http:
        response = await http.get(origin + "/health")
        response.raise_for_status()
        response = await http.get(origin + "/ready")
        response.raise_for_status()
        if not response.json().get("python_ready"):
            raise SystemExit("Piston's Python runtime is not ready.")
        response = await http.post(url, json={})
        if response.status_code != 401:
            raise SystemExit("The MCP endpoint did not reject an unauthenticated request with 401.")
    async with Client(url, auth=token, timeout=300) as client:
        tools = {tool.name for tool in await client.list_tools()}
        required = {
            "ping",
            "list_problems",
            "start_problem",
            "get_problem_description",
            "get_hint",
            "run_tests",
            "submit_solution",
            "get_progress",
        }
        if not required <= tools:
            raise SystemExit(f"Missing MCP tools: {sorted(required - tools)}")
        problems = (await client.call_tool("list_problems", {})).data
        if not problems or (expected_problems is not None and len(problems) != expected_problems):
            raise SystemExit(f"Unexpected problem count: {len(problems)}")
        print(f"Authenticated MCP connection: {len(tools)} tools, {len(problems)} problems.")
        if check_only:
            return
        started = (
            await client.call_tool("start_problem", {"problem_id": "0015-delivery-hold-clusters"})
        ).data
        if started.mode != "remote" or started.files_written or not started.files_to_create:
            raise SystemExit("Remote scaffolding contract failed.")
        attempt_id = started.attempt_id
        await client.call_tool("get_problem_description", {"attempt_id": attempt_id})
        await client.call_tool("get_hint", {"attempt_id": attempt_id, "current_code": ""})
        failed = (
            await client.call_tool(
                "run_tests",
                {
                    "attempt_id": attempt_id,
                    "code": "def merge_delivery_holds(holds, grace_days): return []",
                },
            )
        ).data
        if failed.all_passed:
            raise SystemExit("Incorrect solution unexpectedly passed.")
        passed = (
            await client.call_tool("run_tests", {"attempt_id": attempt_id, "code": SOLUTION})
        ).data
        if not passed.all_passed:
            raise SystemExit(f"Correct solution failed: {passed}")
        submitted = (
            await client.call_tool("submit_solution", {"attempt_id": attempt_id, "code": SOLUTION})
        ).data
        if not submitted.completed:
            raise SystemExit("Passing submission was not completed.")
        progress = (await client.call_tool("get_progress", {})).data
        if "completed" not in progress or "Delivery Hold" not in progress:
            raise SystemExit("Completed attempt is missing from progress.")
        print(
            f"Remote scaffolding, hints, sandbox tests ({passed.tests_total}), "
            "submission and progress passed."
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--expected-problems", type=int)
    parser.add_argument(
        "--check-only", action="store_true", help="Read-only checks; no attempts created."
    )
    args = parser.parse_args()
    asyncio.run(check(args.url, args.expected_problems, args.check_only))


if __name__ == "__main__":
    main()
