"""Mode-specific tests for start_problem."""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server import main
from server.db import base, repo
from server.db.base import Base
from server.db.write_types import ProblemWrite

SAMPLE_PROBLEM: ProblemWrite = {
    "id": "0001-pair-budget-match",
    "title": "Pair Budget Match",
    "difficulty": "easy",
    "tags": [],
    "pattern_tags": ["hash-map-lookup"],
    "description_md": "Return indices of two prices that sum to the budget.",
    "examples": [
        {
            "input": "prices=[4,9,1,8], budget=10",
            "output": "[1, 2]",
            "explanation": "9 + 1 = 10.",
        }
    ],
    "constraints": ["Return any valid pair."],
    "starter_code": {"python": "def pair_budget_match(prices, budget):\n    pass\n"},
    "test_cases": {"python": []},
    "canonical_solution_md": "",
    "fallback_hints": [],
    "common_mistakes": [],
    "follow_up_questions": [],
    "suboptimal_solutions": [],
}


@pytest.fixture(autouse=True)
def in_memory_db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    test_engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(test_engine)
    test_session_local = sessionmaker(bind=test_engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(base, "engine", test_engine)
    monkeypatch.setattr(base, "SessionLocal", test_session_local)
    monkeypatch.chdir(tmp_path)
    repo.upsert_problem(SAMPLE_PROBLEM)


def test_start_problem_local_writes_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERVIEW_MCP_MODE", "local")
    result = main.start_problem("0001-pair-budget-match")

    assert result.mode == "local"
    assert result.files_written
    assert not result.files_to_create
    path = Path(result.files_written[0])
    assert path.exists()
    assert path.name == "solution.py"


def test_start_problem_remote_returns_artifact_without_writing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("INTERVIEW_MCP_MODE", "remote")
    result = main.start_problem("0001-pair-budget-match")

    assert result.mode == "remote"
    assert result.files_written == []
    assert len(result.files_to_create) == 1

    scaffold = result.files_to_create[0]
    assert scaffold.relative_path == "0001-pair-budget-match/solution.py"
    assert "def pair_budget_match" in scaffold.contents
    assert scaffold.sha256

    assert not any(tmp_path.rglob("solution.py"))


def test_get_problem_description_uses_attempt_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("INTERVIEW_MCP_MODE", "remote")
    started = main.start_problem("0001-pair-budget-match")

    description = main.get_problem_description(started.attempt_id)

    assert "# Pair Budget Match" in description
    assert "Return indices" in description
    assert "prices=[4,9,1,8]" in description
    assert "Return any valid pair." in description
