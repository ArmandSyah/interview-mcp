"""
Workspace writer — manages ~/.interview-mcp/active/.

Writes problem.md and solution.{ext} for the active attempt.
Has no database access. Accepts plain data, writes files.
"""

from __future__ import annotations

from pathlib import Path

SUPPORTED_EXTENSIONS: dict[str, str] = {
    "python": "py",
    "javascript": "js",
    "typescript": "ts",
    "java": "java",
    "go": "go",
    "cpp": "cpp",
}

_ACTIVE_DIR = Path.home() / ".interview-mcp" / "active"


def write_active_problem(
    *,
    problem_id: str,
    title: str,
    description_md: str,
    starter_code: str,
    language: str,
) -> Path:
    """Write problem.md and solution.{ext} to the active directory.

    Args:
        problem_id: Problem identifier, used in the problem.md header.
        title: Problem title.
        description_md: Full problem description in Markdown.
        starter_code: Language-specific starter code string.
        language: Language key (e.g. 'python', 'java').

    Returns:
        The active directory Path that was written to.

    Raises:
        ValueError: If language is not in SUPPORTED_EXTENSIONS.
    """
    if language not in SUPPORTED_EXTENSIONS:
        raise ValueError(
            f"Unsupported language '{language}'. Supported: {sorted(SUPPORTED_EXTENSIONS)}"
        )

    ext = SUPPORTED_EXTENSIONS[language]
    _ACTIVE_DIR.mkdir(parents=True, exist_ok=True)

    (_ACTIVE_DIR / "problem.md").write_text(
        f"# [{problem_id}] {title}\n\n{description_md}\n",
        encoding="utf-8",
    )
    (_ACTIVE_DIR / f"solution.{ext}").write_text(starter_code, encoding="utf-8")

    return _ACTIVE_DIR
