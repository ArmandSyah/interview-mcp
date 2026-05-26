"""Unit tests for run_tests orchestration with a fake Piston client."""

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
            {"input": [[1, 2, 3], 5], "expected": [1, 2]},
            {"input": [[1, 1], 2], "expected": [0, 1]},
        ]
    },
    "canonical_solution_md": "",
    "fallback_hints": [],
    "common_mistakes": [],
    "follow_up_questions": [],
    "suboptimal_solutions": [],
}


@pytest.fixture(autouse=True)
def in_memory_db(monkeypatch: pytest.MonkeyPatch) -> None:
    test_engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(test_engine)
    test_session_local = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(base, "engine", test_engine)
    monkeypatch.setattr(base, "SessionLocal", test_session_local)
    monkeypatch.setattr(main, "_piston_client", None)


@pytest.fixture
def attempt_id() -> str:
    repo.upsert_problem(SAMPLE_PROBLEM)
    attempt = repo.create_attempt("0001-pair", "python")
    return attempt.id


def _install_fake_client(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[str], ExecutionResult],
) -> None:
    class FakeClient:
        def execute(
            self, *, language: str, version: str, code: str, **_: object
        ) -> ExecutionResult:
            assert language == "python"
            assert version == main.PYTHON_VERSION
            return handler(code)

    monkeypatch.setattr(main, "_piston_client", FakeClient())


def test_mixed_pass_and_fail(attempt_id: str, monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_code: str) -> ExecutionResult:
        return ExecutionResult(
            stdout="__INTERVIEW_MCP_RESULT__\n[1, 2]\n",
            stderr="",
            exit_code=0,
            timed_out=False,
            wall_time_ms=10,
        )

    _install_fake_client(monkeypatch, handler)

    result = main.run_tests(
        attempt_id,
        "def pair_budget_match(prices, budget): return [1, 2]",
    )

    assert result.tests_total == 2
    assert result.tests_passed == 1
    assert result.all_passed is False
    assert result.tests[0].passed is True
    assert result.tests[1].passed is False
    assert result.tests[1].actual == [1, 2]
    assert result.tests[1].expected == [0, 1]


def test_wrapper_receives_user_code_and_test_input(
    attempt_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured_wrappers: list[str] = []

    def handler(code: str) -> ExecutionResult:
        captured_wrappers.append(code)
        return ExecutionResult(
            stdout="__INTERVIEW_MCP_RESULT__\n[1, 2]\n",
            stderr="",
            exit_code=0,
            timed_out=False,
            wall_time_ms=10,
        )

    _install_fake_client(monkeypatch, handler)

    main.run_tests(attempt_id, "def pair_budget_match(prices, budget): return [1, 2]")

    assert len(captured_wrappers) == 2
    assert "def pair_budget_match" in captured_wrappers[0]
    assert "[[1, 2, 3], 5]" in captured_wrappers[0]
    assert "[[1, 1], 2]" in captured_wrappers[1]


def test_missing_attempt_raises() -> None:
    with pytest.raises(ValueError, match="Attempt"):
        main.run_tests("missing", "def x(): pass")


def test_empty_code_raises(attempt_id: str) -> None:
    with pytest.raises(ValueError, match="code argument is empty"):
        main.run_tests(attempt_id, "")


def test_transport_error_surfaces_per_test(
    attempt_id: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    def handler(_code: str) -> ExecutionResult:
        return ExecutionResult(
            stdout="",
            stderr="",
            exit_code=-1,
            timed_out=False,
            wall_time_ms=0,
            transport_error="piston unreachable",
        )

    _install_fake_client(monkeypatch, handler)

    result = main.run_tests(attempt_id, "def pair_budget_match(p, b): return [0, 0]")

    assert result.all_passed is False
    assert all(test.error == "piston unreachable" for test in result.tests)


def test_timeout_surfaces_per_test(attempt_id: str, monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_code: str) -> ExecutionResult:
        return ExecutionResult(
            stdout="",
            stderr="",
            exit_code=-1,
            timed_out=True,
            wall_time_ms=5000,
        )

    _install_fake_client(monkeypatch, handler)

    result = main.run_tests(attempt_id, "def pair_budget_match(p, b): pass")

    assert all(test.passed is False for test in result.tests)
    assert all("timed out" in (test.error or "") for test in result.tests)


def test_parse_error_surfaces_per_test(attempt_id: str, monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_code: str) -> ExecutionResult:
        return ExecutionResult(
            stdout="no delimiter here",
            stderr="Traceback...",
            exit_code=1,
            timed_out=False,
            wall_time_ms=11,
        )

    _install_fake_client(monkeypatch, handler)

    result = main.run_tests(attempt_id, "def pair_budget_match(p, b): 1 / 0")

    assert result.tests[0].passed is False
    assert "delimiter not found" in (result.tests[0].error or "")
    assert result.tests[0].user_stderr == "Traceback..."


def test_event_recorded(attempt_id: str, monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(_code: str) -> ExecutionResult:
        return ExecutionResult(
            stdout="__INTERVIEW_MCP_RESULT__\n[1, 2]\n",
            stderr="",
            exit_code=0,
            timed_out=False,
            wall_time_ms=10,
        )

    _install_fake_client(monkeypatch, handler)

    main.run_tests(attempt_id, "def pair_budget_match(p, b): return [1, 2]")

    with base.SessionLocal() as session:
        events = session.scalars(select(Event).where(Event.kind == "test_run")).all()

    assert len(events) == 1
    assert events[0].payload == {
        "tests_total": 2,
        "tests_passed": 1,
        "all_passed": False,
    }
