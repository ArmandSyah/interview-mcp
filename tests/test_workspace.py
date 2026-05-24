from pathlib import Path

import pytest

import server.workspace as workspace_module
from server.workspace import (
    build_solution_scaffold_contents,
    scaffold_sha256,
    write_solution_scaffold,
)


@pytest.fixture(autouse=True)
def patch_problem_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(workspace_module, "_problem_dir", lambda: tmp_path)


def _sample_contents(problem_id: str = "0001-pair-budget-match") -> str:
    return build_solution_scaffold_contents(
        problem_id=problem_id,
        title="Pair Budget Match",
        difficulty="easy",
        pattern_tag="hash-map-lookup",
        one_line_description="Return indices of two prices that sum to the budget.",
        example_input="prices=[4,9,1,8], budget=10",
        example_output="[1, 2]",
        starter_code="def pair_budget_match(prices, budget):\n    pass\n",
    )


def _write_sample(problem_id: str = "0001-pair-budget-match") -> Path:
    return write_solution_scaffold(
        problem_id=problem_id,
        contents=_sample_contents(problem_id),
        language="python",
    )


def test_build_contents_contains_starter_code() -> None:
    contents = _sample_contents()
    assert "def pair_budget_match" in contents


def test_build_contents_contains_comment_header() -> None:
    contents = _sample_contents()
    assert "Pair Budget Match" in contents
    assert "easy" in contents
    assert "hash-map-lookup" in contents
    assert "get_problem_description" in contents


def test_header_is_plain_ascii() -> None:
    contents = build_solution_scaffold_contents(
        problem_id="0001-pair-budget-match",
        title="Pair `Budget` Match <!-- hidden -->",
        difficulty="easy",
        pattern_tag="hash-map-lookup",
        one_line_description="Return <indices> of two prices.",
        example_input="prices=[4,9,1,8], budget=10",
        example_output="[1, 2]",
        starter_code="def pair_budget_match(prices, budget):\n    pass\n",
    )
    header = "\n".join(line for line in contents.splitlines() if line.startswith("#"))
    assert "<" not in header
    assert "<!--" not in header
    assert "`" not in header
    assert all(ord(c) < 128 for c in header)


def test_scaffold_hash_is_stable() -> None:
    contents = _sample_contents()
    assert scaffold_sha256(contents) == scaffold_sha256(contents)
    assert scaffold_sha256(contents) != scaffold_sha256(contents + "\n")


def test_writes_solution_py() -> None:
    path = _write_sample()
    assert path.name == "solution.py"
    assert path.exists()


def test_written_solution_matches_canonical_contents() -> None:
    contents = _sample_contents()
    path = write_solution_scaffold(
        problem_id="0001-pair-budget-match",
        contents=contents,
        language="python",
    )
    assert path.read_text(encoding="utf-8") == contents


def test_no_problem_md_written(tmp_path: Path) -> None:
    _write_sample()
    assert not any(tmp_path.rglob("problem.md"))


def test_no_tests_py_written(tmp_path: Path) -> None:
    _write_sample()
    assert not any(tmp_path.rglob("tests.py"))


def test_creates_problem_subdirectory() -> None:
    path = _write_sample()
    assert path.parent.name == "0001-pair-budget-match"


def test_invalid_problem_id_raises() -> None:
    with pytest.raises(ValueError, match="Invalid problem_id"):
        write_solution_scaffold(
            problem_id="../../etc/passwd",
            contents="",
            language="python",
        )


def test_unsupported_language_raises() -> None:
    with pytest.raises(ValueError, match="Unsupported language"):
        write_solution_scaffold(
            problem_id="0001-pair",
            contents="",
            language="cobol",
        )
