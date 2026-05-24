"""
Execution mode detection.

local  = stdio MCP server launched by the user's IDE on their machine.
remote = hosted MCP server reached over the network.

This distinction is about filesystem authority. Local mode may write scaffold
files to the user's working directory. Remote mode must return scaffold files
as data and perform no local writes.
"""

from __future__ import annotations

import os
from typing import Literal, cast

ExecutionMode = Literal["local", "remote"]


def get_execution_mode() -> ExecutionMode:
    """Return the configured execution mode."""
    raw = os.environ.get("INTERVIEW_MCP_MODE", "local").lower().strip()
    if raw not in {"local", "remote"}:
        raise ValueError(f"Invalid INTERVIEW_MCP_MODE {raw!r}. Expected 'local' or 'remote'.")
    return cast(ExecutionMode, raw)
