from __future__ import annotations

import pytest

from server.core.mode import get_execution_mode


def test_default_mode_is_local(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("INTERVIEW_MCP_MODE", raising=False)
    assert get_execution_mode() == "local"


def test_remote_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERVIEW_MCP_MODE", "remote")
    assert get_execution_mode() == "remote"


def test_mode_is_case_insensitive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERVIEW_MCP_MODE", "REMOTE")
    assert get_execution_mode() == "remote"


def test_invalid_mode_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERVIEW_MCP_MODE", "banana")
    with pytest.raises(ValueError, match="Invalid INTERVIEW_MCP_MODE"):
        get_execution_mode()
