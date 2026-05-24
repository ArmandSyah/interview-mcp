# tests/test_repo_smoke.py
from __future__ import annotations

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker

from server.db import base, repo
from server.db.base import Base
from server.db.write_types import ProblemWrite

SAMPLE_PROBLEM: ProblemWrite = {
    "id": "0001-pair-budget-match",
    "title": "Pair Budget Match",
    "difficulty": "easy",
    "tags": ["array", "hash-map"],
    "pattern_tags": ["hash-map-lookup"],
    "description_md": "Find two prices that add up to budget.",
    "examples": [],
    "constraints": [],
    "starter_code": {"python": "def pair_budget_match(): pass"},
    "test_cases": {"python": []},
    "canonical_solution_md": "Use a hash map.",
    "fallback_hints": ["Think about complements."],
    "common_mistakes": [],
    "follow_up_questions": [],
    "suboptimal_solutions": [],
}

SAMPLE_PROBLEM_2: ProblemWrite = {
    "id": "0002-valid-parentheses",
    "title": "Valid Parentheses",
    "difficulty": "hard",
    "tags": ["stack"],
    "pattern_tags": ["stack"],
    "description_md": "Given a string of brackets, return whether it is valid.",
    "examples": [],
    "constraints": [],
    "starter_code": {"python": "def is_valid(s: str) -> bool: pass"},
    "test_cases": {"python": []},
    "canonical_solution_md": "Use a stack.",
    "fallback_hints": ["Think about what to do when you see an opening bracket."],
    "common_mistakes": [],
    "follow_up_questions": [],
    "suboptimal_solutions": [],
}


@pytest.fixture(autouse=True)
def in_memory_db(monkeypatch: pytest.MonkeyPatch) -> None:
    test_engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(test_engine)
    test_session_local = sessionmaker(
        bind=test_engine,
        autoflush=False,
        autocommit=False,
    )
    monkeypatch.setattr(base, "engine", test_engine)
    monkeypatch.setattr(base, "SessionLocal", test_session_local)


# --- schema ---


def test_tables_exist() -> None:
    inspector = inspect(base.engine)
    tables = inspector.get_table_names()
    assert "problems" in tables
    assert "attempts" in tables
    assert "events" in tables
    assert "state" in tables


# --- upsert_problem / get_problem ---


def test_upsert_and_get_problem() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    problem = repo.get_problem("0001-pair-budget-match")
    assert problem is not None
    assert problem.title == "Pair Budget Match"
    assert problem.difficulty == "easy"
    assert problem.tags == ["array", "hash-map"]
    assert problem.fallback_hints == ["Think about complements."]


def test_get_problem_returns_none_for_missing_id() -> None:
    problem = repo.get_problem("does-not-exist")
    assert problem is None


def test_upsert_updates_existing_problem() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    updated = {**SAMPLE_PROBLEM, "title": "Updated Title"}
    repo.upsert_problem(updated)  # type: ignore[arg-type]
    problem = repo.get_problem("0001-pair-budget-match")
    assert problem is not None
    assert problem.title == "Updated Title"


# --- list_problems ---


def test_list_problems_returns_all() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    repo.upsert_problem(SAMPLE_PROBLEM_2)
    results = repo.list_problems()
    assert len(results) == 2


def test_list_problems_filters_by_difficulty() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    repo.upsert_problem(SAMPLE_PROBLEM_2)
    easy = repo.list_problems(difficulty="easy")
    hard = repo.list_problems(difficulty="hard")
    assert len(easy) == 1
    assert easy[0].id == "0001-pair-budget-match"
    assert len(hard) == 1
    assert hard[0].id == "0002-valid-parentheses"


def test_list_problems_filters_by_tag() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    repo.upsert_problem(SAMPLE_PROBLEM_2)
    results = repo.list_problems(tag="stack")
    assert len(results) == 1
    assert results[0].id == "0002-valid-parentheses"


def test_list_problems_no_match_returns_empty() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    assert repo.list_problems(difficulty="medium") == []
    assert repo.list_problems(tag="tree") == []


def test_list_problems_filters_combine() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    repo.upsert_problem(SAMPLE_PROBLEM_2)
    results = repo.list_problems(difficulty="easy", tag="hash-map")
    assert len(results) == 1
    assert results[0].id == "0001-pair-budget-match"
    assert repo.list_problems(difficulty="hard", tag="hash-map") == []


# --- create_attempt / get_attempt ---


def test_create_attempt_returns_attempt() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    attempt = repo.create_attempt("0001-pair-budget-match", "python")
    assert attempt.id is not None
    assert attempt.problem_id == "0001-pair-budget-match"
    assert attempt.language == "python"
    assert attempt.status == "in_progress"
    assert attempt.started_at is not None
    assert attempt.completed_at is None


def test_get_attempt_returns_correct_row() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    attempt = repo.create_attempt("0001-pair-budget-match", "python")
    fetched = repo.get_attempt(attempt.id)
    assert fetched is not None
    assert fetched.id == attempt.id


def test_get_attempt_returns_none_for_missing_id() -> None:
    assert repo.get_attempt("does-not-exist") is None


# --- active attempt ---


def test_create_attempt_sets_active() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    attempt = repo.create_attempt("0001-pair-budget-match", "python")
    active = repo.get_active_attempt()
    assert active is not None
    assert active.id == attempt.id


def test_set_active_attempt_overwrites_previous() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    repo.upsert_problem(SAMPLE_PROBLEM_2)
    attempt1 = repo.create_attempt("0001-pair-budget-match", "python")
    attempt2 = repo.create_attempt("0002-valid-parentheses", "python")
    active = repo.get_active_attempt()
    assert active is not None
    assert active.id == attempt2.id
    assert active.id != attempt1.id


def test_get_active_attempt_returns_none_when_not_set() -> None:
    assert repo.get_active_attempt() is None


def test_clear_active_attempt() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    repo.create_attempt("0001-pair-budget-match", "python")
    repo.clear_active_attempt()
    assert repo.get_active_attempt() is None


def test_clear_active_attempt_is_idempotent() -> None:
    # should not raise when called with nothing active
    repo.clear_active_attempt()
    repo.clear_active_attempt()
    assert repo.get_active_attempt() is None


# --- mark_completed ---


def test_mark_completed_sets_status_and_timestamp() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    attempt = repo.create_attempt("0001-pair-budget-match", "python")
    repo.mark_completed(attempt.id)
    completed = repo.get_attempt(attempt.id)
    assert completed is not None
    assert completed.status == "completed"
    assert completed.completed_at is not None


def test_mark_completed_clears_active() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    attempt = repo.create_attempt("0001-pair-budget-match", "python")
    repo.mark_completed(attempt.id)
    assert repo.get_active_attempt() is None


def test_mark_completed_on_missing_id_does_not_raise() -> None:
    # should silently do nothing, not raise
    repo.mark_completed("does-not-exist")


# --- record_event ---


def test_record_event_persists_row() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    attempt = repo.create_attempt("0001-pair-budget-match", "python")
    event = repo.record_event(attempt.id, "hint_requested", {"depth": 1})
    assert event.id is not None
    assert event.kind == "hint_requested"
    assert event.payload == {"depth": 1}
    assert event.attempt_id == attempt.id
    assert event.created_at is not None


def test_record_event_with_no_payload() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    attempt = repo.create_attempt("0001-pair-budget-match", "python")
    event = repo.record_event(attempt.id, "jailbreak_blocked")
    assert event.payload is None


def test_record_multiple_events_for_same_attempt() -> None:
    repo.upsert_problem(SAMPLE_PROBLEM)
    attempt = repo.create_attempt("0001-pair-budget-match", "python")
    repo.record_event(attempt.id, "hint_requested", {"depth": 1})
    repo.record_event(attempt.id, "hint_requested", {"depth": 2})
    repo.record_event(attempt.id, "test_run", {"passed": 3, "failed": 1})
    # no assertion on count here since we don't have a list_events yet,
    # but none of these should raise
