"""Unit tests for get_progress."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server import main
from server.db import base, repo
from server.db.base import Base
from server.db.write_types import ProblemWrite

P1: ProblemWrite = {
    "id": "0001",
    "title": "First",
    "difficulty": "easy",
    "tags": [],
    "pattern_tags": [],
    "description_md": "",
    "examples": [],
    "constraints": [],
    "starter_code": {"python": "def first(): pass\n"},
    "test_cases": {"python": []},
    "canonical_solution_md": "",
    "fallback_hints": [],
    "common_mistakes": [],
    "follow_up_questions": [],
    "suboptimal_solutions": [],
}

P2: ProblemWrite = {
    **P1,
    "id": "0002",
    "title": "Second",
    "difficulty": "medium",
    "starter_code": {"python": "def second(): pass\n"},
}


@pytest.fixture(autouse=True)
def in_memory_db(monkeypatch: pytest.MonkeyPatch) -> None:
    test_engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(test_engine)
    test_session_local = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(base, "engine", test_engine)
    monkeypatch.setattr(base, "SessionLocal", test_session_local)


def test_empty_progress_message() -> None:
    result = main.get_progress()

    assert "No attempts yet" in result


def test_progress_shows_attempts_and_summary() -> None:
    repo.upsert_problem(P1)
    repo.upsert_problem(P2)
    first_attempt = repo.create_attempt("0001", "python")
    repo.create_attempt("0002", "python")
    repo.mark_completed(first_attempt.id)

    result = main.get_progress()

    assert "| Date | Problem | Difficulty | Status |" in result
    assert "First" in result
    assert "Second" in result
    assert "completed" in result
    assert "in_progress" in result
    assert "1 completed" in result
    assert "1 in progress" in result
    assert "2 total" in result


def test_progress_orders_recent_first() -> None:
    repo.upsert_problem(P1)
    repo.upsert_problem(P2)
    repo.create_attempt("0001", "python")
    repo.create_attempt("0002", "python")

    result = main.get_progress()

    assert result.index("Second") < result.index("First")


def test_limit_caps_results() -> None:
    repo.upsert_problem(P1)
    for _ in range(5):
        repo.create_attempt("0001", "python")

    result = main.get_progress(limit=2)

    assert result.count("| First |") == 2


def test_invalid_limit_raises() -> None:
    with pytest.raises(ValueError, match="limit"):
        main.get_progress(limit=0)
