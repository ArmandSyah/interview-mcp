from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import cast

from server.db import repo
from server.db.write_types import ProblemWrite

PROBLEMS_DIR = Path(os.getenv("INTERVIEW_MCP_PROBLEMS_DIR", "problems"))

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


def load_problem_files() -> list[ProblemWrite]:
    problems: list[ProblemWrite] = []

    for path in sorted(PROBLEMS_DIR.glob("**/*.json")):
        try:
            raw = json.loads(path.read_text())
        except Exception as exc:
            print(f"[seed] skipping {path.name}: failed to parse ({exc})", file=sys.stderr)
            continue

        if not isinstance(raw, dict):
            print(f"[seed] skipping {path.name}: top level is not an object", file=sys.stderr)
            continue

        missing = REQUIRED_FIELDS - raw.keys()
        if missing:
            print(f"[seed] skipping {path.name}: missing fields {missing}", file=sys.stderr)
            continue

        problems.append(cast(ProblemWrite, raw))

    return problems


def seed_problems() -> None:
    problems = load_problem_files()
    succeeded = 0

    for problem in problems:
        try:
            repo.upsert_problem(problem)
            succeeded += 1
        except Exception as exc:
            print(f"[seed] failed to upsert {problem.get('id')}: {exc}", file=sys.stderr)

    print(f"[seed] {succeeded}/{len(problems)} problems loaded", file=sys.stderr)
