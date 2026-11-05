"""Build the cloud seed from public examples. Do not read private content or a database."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

from server.db.revisions import snapshot_problem
from server.db.schemas import ProblemRead
from server.design.catalog import PROBLEMS
from server.workspace import build_solution_scaffold_contents, scaffold_sha256

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "supabase/migrations/20261028163500_public_catalog.sql"


def build_seed() -> str:
    """Return SQL for the public catalog, with the same revisions and scaffolds as Python."""
    rows: list[tuple[str, str, str, dict[str, object], dict[str, str] | None]] = []
    epoch = datetime(2026, 1, 1, tzinfo=UTC)
    for path in sorted((ROOT / "problems/examples").glob("*.json")):
        source = json.loads(path.read_text(encoding="utf-8"))
        problem = ProblemRead.model_validate({**source, "created_at": epoch, "updated_at": epoch})
        snapshot, revision = snapshot_problem(problem)
        example = problem.examples[0]
        contents = build_solution_scaffold_contents(
            problem_id=problem.id,
            title=problem.title,
            difficulty=problem.difficulty,
            pattern_tag=problem.pattern_tags[0] if problem.pattern_tags else "",
            one_line_description=next(
                (
                    line.strip().lstrip("# ").strip()
                    for line in problem.description_md.splitlines()
                    if line.strip()
                ),
                problem.title,
            ),
            example_input=example.input,
            example_output=example.output,
            starter_code=problem.starter_code["python"],
        )
        rows.append(
            (
                "coding",
                problem.id,
                revision,
                snapshot,
                {
                    "relative_path": f"{problem.id}/solution.py",
                    "language": "python",
                    "contents": contents,
                    "sha256": scaffold_sha256(contents),
                },
            )
        )
    for design_problem in sorted(PROBLEMS.values(), key=lambda value: value.id):
        rows.append(
            (
                "design",
                design_problem.id,
                design_problem.revision,
                design_problem.model_dump(mode="json"),
                None,
            )
        )

    def literal(value: object) -> str:
        # PostgreSQL standard strings with explicit quote escaping. No interpolation of SQL.
        return (
            "'"
            + json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("'", "''")
            + "'::jsonb"
        )

    statements = ["-- Generated with python -m tools.cloud_catalog. Public examples only."]
    for kind, problem_id, revision, payload, scaffold in rows:
        statements.append(
            f"update public.iwb_content set available=false where kind='{kind}' "
            f"and problem_id='{problem_id}' and revision<>'{revision}';"
        )
        statements.append(
            "insert into public.iwb_content(kind, problem_id, revision, payload, scaffold) values ("
            f"'{kind}', '{problem_id}', '{revision}', {literal(payload)}, {literal(scaffold)}) "
            "on conflict (kind, problem_id, revision) do update set available=true;"
        )
    return "\n".join(statements) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    arguments = parser.parse_args()
    output = arguments.output
    seed = build_seed()
    if arguments.check:
        if not output.exists() or output.read_text(encoding="utf-8") != seed:
            raise SystemExit("Cloud catalog differs from the public examples. Rebuild the seed.")
    elif output.exists():
        if output.read_text(encoding="utf-8") != seed:
            raise SystemExit("Do not replace a migration. Select a new path with --output.")
    else:
        with output.open("x", encoding="utf-8") as stream:
            stream.write(seed)
    print("Public cloud catalog is consistent with the public sources.")


if __name__ == "__main__":
    main()
