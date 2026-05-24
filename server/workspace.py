"""
Workspace scaffolder.

Builds canonical solution.py contents for both local and remote mode. Local
mode may write those contents to ./<problem_id>/solution.py. Remote mode
returns the same contents as a scaffold artifact and writes nothing.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

_SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9\-]{0,60}$")

SUPPORTED_EXTENSIONS: dict[str, str] = {
    "python": "py",
}


def _validate_problem_id(problem_id: str) -> None:
    """Raise ValueError if problem_id is not a safe directory name."""
    if not _SAFE_ID.match(problem_id):
        raise ValueError(
            f"Invalid problem_id {problem_id!r}. "
            "Must be lowercase alphanumeric and hyphens only, max 61 chars."
        )


def _problem_dir() -> Path:
    """Return the current working directory. Extracted for monkeypatching."""
    return Path.cwd()


def _plain_ascii(value: object) -> str:
    """Convert header fields to plain ASCII with markup-ish chars removed."""
    text = str(value)
    text = text.encode("ascii", "ignore").decode("ascii")
    for token in ("<!--", "-->", "<", ">", "`", "**"):
        text = text.replace(token, "")
    return " ".join(text.split())


def scaffold_sha256(contents: str) -> str:
    """Return SHA-256 of scaffold contents for remote integrity checks."""
    return hashlib.sha256(contents.encode("utf-8")).hexdigest()


def _build_comment_header(
    *,
    problem_id: str,
    title: str,
    difficulty: str,
    pattern_tag: str,
    one_line_description: str,
    example_input: str,
    example_output: str,
) -> str:
    """Build a plain-ASCII comment header."""
    _validate_problem_id(problem_id)

    sep = "# " + "-" * 60
    return (
        f"{sep}\n"
        f"# [{problem_id}] {_plain_ascii(title)}  |  "
        f"{_plain_ascii(difficulty)}  |  {_plain_ascii(pattern_tag)}\n"
        f"{sep}\n"
        f"# {_plain_ascii(one_line_description)}\n"
        f"#\n"
        f"# Example: {_plain_ascii(example_input)} -> {_plain_ascii(example_output)}\n"
        f"#\n"
        f"# Full description: call get_problem_description(attempt_id)\n"
        f"{sep}\n"
        "\n"
    )


def build_solution_scaffold_contents(
    *,
    problem_id: str,
    title: str,
    difficulty: str,
    pattern_tag: str,
    one_line_description: str,
    example_input: str,
    example_output: str,
    starter_code: str,
) -> str:
    """Return canonical solution.py contents for local and remote mode."""
    header = _build_comment_header(
        problem_id=problem_id,
        title=title,
        difficulty=difficulty,
        pattern_tag=pattern_tag,
        one_line_description=one_line_description,
        example_input=example_input,
        example_output=example_output,
    )
    return header + starter_code


def write_solution_scaffold(
    *,
    problem_id: str,
    contents: str,
    language: str,
) -> Path:
    """Write solution.{ext} with canonical contents to ./<problem_id>/."""
    _validate_problem_id(problem_id)

    if language not in SUPPORTED_EXTENSIONS:
        raise ValueError(
            f"Unsupported language {language!r}. Supported: {sorted(SUPPORTED_EXTENSIONS)}"
        )

    ext = SUPPORTED_EXTENSIONS[language]
    root = _problem_dir().resolve()
    problem_dir = (root / problem_id).resolve()

    if root not in problem_dir.parents:
        raise ValueError(f"Path traversal detected for problem_id {problem_id!r}")

    problem_dir.mkdir(parents=True, exist_ok=True)

    solution_path = problem_dir / f"solution.{ext}"
    solution_path.write_text(contents, encoding="utf-8")
    return solution_path
