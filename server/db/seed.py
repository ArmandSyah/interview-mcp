from __future__ import annotations

import ast
import json
import os
import sys
from pathlib import Path
from typing import cast

from server.db import repo
from server.db.content import ProblemContent as ProblemContent
from server.db.write_types import ProblemWrite

PROBLEMS_DIR = Path(
    os.getenv("INTERVIEW_MCP_PROBLEMS_DIR")
    or Path(__file__).resolve().parents[2] / "problems" / "examples"
)


REQUIRED_FIELDS = {
    "id",
    "title",
    "difficulty",
    "description_md",
    "canonical_solution_md",
    "tags",
    "starter_code",
    "test_cases",
    "fallback_hints",
}

PROBLEM_FIELDS = {
    "id",
    "title",
    "difficulty",
    "tags",
    "pattern_tags",
    "description_md",
    "examples",
    "constraints",
    "starter_code",
    "test_cases",
    "canonical_solution_md",
    "fallback_hints",
    "common_mistakes",
    "follow_up_questions",
    "suboptimal_solutions",
}


def load_problem_files(*, strict: bool = False) -> list[ProblemWrite]:
    problems: list[ProblemWrite] = []
    seen: set[str] = set()
    if strict and not PROBLEMS_DIR.is_dir():
        raise ValueError(f"Problem directory does not exist: {PROBLEMS_DIR}")

    for path in sorted(PROBLEMS_DIR.glob("**/*.json")):
        try:
            raw = json.loads(path.read_text())
        except (OSError, ValueError) as exc:
            if strict:
                raise ValueError(f"Invalid problem JSON: {path.name}") from exc
            print(f"[seed] skipping {path.name}: failed to parse ({exc})", file=sys.stderr)
            continue

        if not isinstance(raw, dict):
            if strict:
                raise ValueError(f"Problem {path.name}: top level must be an object")
            print(f"[seed] skipping {path.name}: top level is not an object", file=sys.stderr)
            continue

        missing = REQUIRED_FIELDS - raw.keys()
        if missing:
            if strict:
                raise ValueError(f"Problem {path.name}: missing fields {sorted(missing)}")
            print(f"[seed] skipping {path.name}: missing fields {missing}", file=sys.stderr)
            continue

        try:
            problem_data = ProblemContent.model_validate(raw).model_dump()
            if strict:
                starter = problem_data["starter_code"].get("python", "")
                tree = ast.parse(starter)
                functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
                if len(functions) != 1 or any(
                    not isinstance(node, ast.FunctionDef | ast.ClassDef) for node in tree.body
                ):
                    raise ValueError("Python starter must define exactly one top-level function")
                function = functions[0]
                if function.decorator_list or any(
                    not isinstance(node, ast.Pass)
                    and not (
                        isinstance(node, ast.Expr)
                        and isinstance(node.value, ast.Constant)
                        and isinstance(node.value.value, str)
                    )
                    for node in function.body
                ):
                    raise ValueError("Python starter must contain only a docstring and pass")
                cases = problem_data["test_cases"].get("python", [])
                if not cases or len(cases) > 100:
                    raise ValueError("Each problem must have 1-100 Python test cases")
            problem_id = problem_data["id"]
            if problem_id in seen:
                raise ValueError(f"Duplicate problem ID: {problem_id}")
            seen.add(problem_id)
            problems.append(cast(ProblemWrite, problem_data))
        except (ValueError, SyntaxError) as exc:
            if strict:
                raise ValueError(f"Problem {path.name} failed runtime validation: {exc}") from exc
            print(f"[seed] skipping {path.name}: {exc}", file=sys.stderr)

    if strict and not problems:
        raise ValueError(f"No valid problems found in {PROBLEMS_DIR}")

    return problems


def seed_problems(*, strict: bool = False) -> None:
    problems = load_problem_files(strict=strict)
    succeeded = 0

    for problem in problems:
        try:
            repo.upsert_problem(problem)
            succeeded += 1
        except Exception as exc:
            if strict:
                raise RuntimeError(f"Failed to load problem {problem['id']}") from exc
            print(f"[seed] failed to upsert {problem.get('id')}: {exc}", file=sys.stderr)

    print(f"[seed] {succeeded}/{len(problems)} problems loaded", file=sys.stderr)
    if strict:
        from server.distribution.packs import active_manifests

        pack_ids = [problem.id for pack in active_manifests() for problem in pack.coding]
        repo.hide_removed_problems([problem["id"] for problem in problems] + pack_ids)
