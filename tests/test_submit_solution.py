"""Tests for submit_solution with fake Piston and LLM provider dependencies."""

from __future__ import annotations

from collections.abc import Callable

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from server import main
from server.db import base, repo
from server.db.base import Base
from server.db.models import Event
from server.db.write_types import ProblemWrite
from server.sandbox.client import ExecutionResult

SAMPLE_PROBLEM: ProblemWrite = {
    "id": "0001-pair",
    "title": "Pair",
    "difficulty": "easy",
    "tags": [],
    "pattern_tags": [],
    "description_md": "Find a pair.",
    "examples": [],
    "constraints": [],
    "starter_code": {"python": "def pair_budget_match(prices, budget):\n    pass\n"},
    "test_cases": {
        "python": [
            {"input": [[1, 2], 3], "expected": [0, 1]},
        ]
    },
    "canonical_solution_md": "",
    "fallback_hints": [],
    "common_mistakes": [],
    "follow_up_questions": [],
    "suboptimal_solutions": [],
}


class FakeProvider:
    def __init__(self, response: str = "1. Complexity?\n2. Edge cases?") -> None:
        self.response = response
        self.calls = 0
        self.last_system_message = ""
        self.last_user_message = ""
        self.last_max_tokens = 0

    def generate(self, system: str, user: str, max_tokens: int = 400) -> str:
        self.calls += 1
        self.last_system_message = system
        self.last_user_message = user
        self.last_max_tokens = max_tokens
        return self.response


class BrokenProvider:
    def generate(self, system: str, user: str, max_tokens: int = 400) -> str:
        raise RuntimeError("network down")


@pytest.fixture(autouse=True)
def in_memory_db(monkeypatch: pytest.MonkeyPatch) -> None:
    test_engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(test_engine)
    test_session_local = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(base, "engine", test_engine)
    monkeypatch.setattr(base, "SessionLocal", test_session_local)
    monkeypatch.setattr(main, "_piston_client", None)
    monkeypatch.setattr(main, "_followup_prompt", None)


@pytest.fixture
def attempt_id() -> str:
    repo.upsert_problem(SAMPLE_PROBLEM)
    attempt = repo.create_attempt("0001-pair", "python")
    return attempt.id


def _install_fakes(
    monkeypatch: pytest.MonkeyPatch,
    *,
    handler: Callable[[str], ExecutionResult],
    provider: object,
) -> None:
    class FakeClient:
        def execute(
            self, *, language: str, version: str, code: str, **_: object
        ) -> ExecutionResult:
            assert language == "python"
            assert version == main.PYTHON_VERSION
            return handler(code)

    monkeypatch.setattr(main, "_piston_client", FakeClient())
    monkeypatch.setattr(main, "get_provider", lambda: provider)


def _passing_execution() -> ExecutionResult:
    return ExecutionResult(
        stdout="__INTERVIEW_MCP_RESULT__\n[0, 1]\n",
        stderr="",
        exit_code=0,
        timed_out=False,
        wall_time_ms=10,
    )


def test_passing_solution_marks_completed_and_returns_followups(
    attempt_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = FakeProvider()
    _install_fakes(monkeypatch, handler=lambda _: _passing_execution(), provider=provider)

    code = "def pair_budget_match(prices, budget): return [0, 1]"
    result = main.submit_solution(attempt_id, code)

    assert result.completed is True
    assert result.test_run.all_passed is True
    assert result.followup_questions == "1. Complexity?\n2. Edge cases?"
    assert result.message == "All tests passed. Attempt completed."
    assert provider.calls == 1
    assert provider.last_max_tokens == 300
    assert "ask exactly 2 follow-up questions" in provider.last_system_message.lower()
    assert code in provider.last_user_message

    attempt = repo.get_attempt(attempt_id)
    assert attempt is not None
    assert attempt.status == "completed"


def test_failing_solution_does_not_complete_or_generate_followups(
    attempt_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    def handler(_: str) -> ExecutionResult:
        return ExecutionResult(
            stdout="__INTERVIEW_MCP_RESULT__\n[9, 9]\n",
            stderr="",
            exit_code=0,
            timed_out=False,
            wall_time_ms=10,
        )

    provider = FakeProvider()
    _install_fakes(monkeypatch, handler=handler, provider=provider)

    result = main.submit_solution(
        attempt_id, "def pair_budget_match(prices, budget): return [9, 9]"
    )

    assert result.completed is False
    assert result.test_run.all_passed is False
    assert result.followup_questions is None
    assert "0/1 tests passed" in result.message
    assert provider.calls == 0

    attempt = repo.get_attempt(attempt_id)
    assert attempt is not None
    assert attempt.status == "in_progress"


def test_provider_failure_uses_fallback_questions_and_still_completes(
    attempt_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fakes(
        monkeypatch,
        handler=lambda _: _passing_execution(),
        provider=BrokenProvider(),
    )

    result = main.submit_solution(
        attempt_id, "def pair_budget_match(prices, budget): return [0, 1]"
    )

    assert result.completed is True
    assert result.followup_questions is not None
    assert "complexity" in result.followup_questions.lower()

    attempt = repo.get_attempt(attempt_id)
    assert attempt is not None
    assert attempt.status == "completed"


def test_submission_event_recorded(attempt_id: str, monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fakes(
        monkeypatch,
        handler=lambda _: _passing_execution(),
        provider=FakeProvider(),
    )

    main.submit_solution(attempt_id, "def pair_budget_match(prices, budget): return [0, 1]")

    with base.SessionLocal() as session:
        events = session.scalars(select(Event).where(Event.kind == "submission")).all()

    assert len(events) == 1
    assert events[0].payload == {
        "tests_passed": 1,
        "tests_total": 1,
    }


def test_submit_solution_never_reads_active_solution(
    attempt_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_fakes(
        monkeypatch,
        handler=lambda _: _passing_execution(),
        provider=FakeProvider(),
    )

    def explode(*_: object, **__: object) -> str:
        raise AssertionError("read_active_solution must not be called")

    monkeypatch.setattr(main, "read_active_solution", explode, raising=False)

    result = main.submit_solution(
        attempt_id, "def pair_budget_match(prices, budget): return [0, 1]"
    )

    assert result.completed is True
