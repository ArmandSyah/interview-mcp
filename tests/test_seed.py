from __future__ import annotations

import json
from pathlib import Path

import pytest

from server.db import seed


def test_load_problem_files_recurses_into_examples(
    monkeypatch,
    tmp_path: Path,
) -> None:
    examples_dir = tmp_path / "examples"
    examples_dir.mkdir()
    problem_path = examples_dir / "0001-example.json"
    problem_path.write_text(
        json.dumps(
            {
                "id": "0001-example",
                "title": "Example",
                "difficulty": "easy",
                "description_md": "Example description.",
                "canonical_solution_md": "Example solution.",
                "tags": ["array"],
                "pattern_tags": ["scan"],
                "examples": [],
                "constraints": [],
                "starter_code": {"python": "def solve() -> int:\n    pass\n"},
                "test_cases": {"python": []},
                "fallback_hints": ["Think about scanning."],
                "common_mistakes": [],
                "follow_up_questions": [],
                "suboptimal_solutions": [],
                "pattern_spec": "private/content-factory/path.md",
            },
        ),
    )
    monkeypatch.setattr(seed, "PROBLEMS_DIR", tmp_path)

    loaded = seed.load_problem_files()

    assert [problem["id"] for problem in loaded] == ["0001-example"]
    assert "pattern_spec" not in loaded[0]


def test_remote_seed_requires_existing_nonempty_library(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(seed, "PROBLEMS_DIR", tmp_path / "missing")
    with pytest.raises(ValueError, match="does not exist"):
        seed.load_problem_files(strict=True)
    monkeypatch.setattr(seed, "PROBLEMS_DIR", tmp_path)
    with pytest.raises(ValueError, match="No valid problems"):
        seed.load_problem_files(strict=True)


def test_remote_seed_rejects_duplicate_ids(monkeypatch, tmp_path) -> None:
    example = Path(__file__).parents[1] / "problems/examples/0015-delivery-hold-clusters.json"
    (tmp_path / "first.json").write_text(example.read_text())
    (tmp_path / "duplicate.json").write_text(example.read_text())
    monkeypatch.setattr(seed, "PROBLEMS_DIR", tmp_path)
    with pytest.raises(ValueError, match="Duplicate problem ID"):
        seed.load_problem_files(strict=True)
