"""
Test wrapper construction and result parsing.

Pure functions only: no HTTP, no Piston, no database, no filesystem. This layer
turns user function code into a runnable Python script and parses that script's
stdout back into data.
"""

from __future__ import annotations

import ast
import json
from typing import Any

_RESULT_DELIMITER = "__INTERVIEW_MCP_RESULT__"


def extract_function_name(starter_code: str) -> str:
    """Extract the first top-level function name from starter code."""
    tree = ast.parse(starter_code)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            return node.name
    raise ValueError("No top-level function definition found in starter code")


def build_wrapper(
    *,
    user_code: str,
    function_name: str,
    test_input: list[Any],
) -> str:
    """Build a Python script that runs the user's function on one test input."""
    serialized_input = json.dumps(test_input)
    return f"""{user_code}

import json as _interview_mcp_json
_interview_mcp_inputs = _interview_mcp_json.loads({serialized_input!r})
_interview_mcp_result = {function_name}(*_interview_mcp_inputs)
print({_RESULT_DELIMITER!r})
print(_interview_mcp_json.dumps(_interview_mcp_result))
"""


def parse_result(stdout: str) -> tuple[str, Any | None, str | None]:
    """Parse stdout emitted by a wrapper script.

    Returns:
        A tuple of `(user_stdout, parsed_result, parse_error)`.
    """
    if _RESULT_DELIMITER not in stdout:
        return stdout, None, "result delimiter not found (user code likely crashed)"

    user_stdout, _, result_section = stdout.partition(_RESULT_DELIMITER)
    result_lines = result_section.strip().splitlines()
    if not result_lines:
        return user_stdout, None, "no result line after delimiter"

    try:
        parsed = json.loads(result_lines[0])
    except json.JSONDecodeError as exc:
        return user_stdout, None, f"result line was not valid JSON: {exc}"

    return user_stdout, parsed, None
