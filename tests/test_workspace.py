from pathlib import Path

import pytest

import server.workspace as workspace_module
from server.workspace import write_active_problem


@pytest.fixture(autouse=True)
def patch_active_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(workspace_module, "_ACTIVE_DIR", tmp_path)


def test_write_creates_problem_md() -> None:
    write_active_problem(
        problem_id="0001",
        title="Two Sum",
        description_md="## Description\nFind two numbers.",
        starter_code="def solution(): pass",
        language="python",
    )
    content = (workspace_module._ACTIVE_DIR / "problem.md").read_text()
    assert "[0001] Two Sum" in content
    assert "Find two numbers." in content


def test_write_creates_solution_file() -> None:
    write_active_problem(
        problem_id="0001",
        title="Two Sum",
        description_md="",
        starter_code="def solution(): pass",
        language="python",
    )
    assert (workspace_module._ACTIVE_DIR / "solution.py").read_text() == "def solution(): pass"


def test_unsupported_language_raises() -> None:
    with pytest.raises(ValueError, match="Unsupported language"):
        write_active_problem(
            problem_id="0001",
            title="Two Sum",
            description_md="",
            starter_code="",
            language="cobol",
        )


def test_write_creates_active_dir_if_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    nested = tmp_path / "deep" / "nested"
    monkeypatch.setattr(workspace_module, "_ACTIVE_DIR", nested)
    write_active_problem(
        problem_id="0001",
        title="Two Sum",
        description_md="",
        starter_code="",
        language="python",
    )
    assert nested.is_dir()


@pytest.mark.parametrize(
    "language,ext",
    [
        ("python", "py"),
        ("javascript", "js"),
        ("java", "java"),
        ("go", "go"),
    ],
)
def test_correct_extension_per_language(language: str, ext: str) -> None:
    write_active_problem(
        problem_id="0001",
        title="T",
        description_md="",
        starter_code="",
        language=language,
    )
    assert (workspace_module._ACTIVE_DIR / f"solution.{ext}").exists()
