"""Offline draft validation and review-bound release compilation; never publish or sign."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from server.distribution.manifest import PackContent, PackManifest, Provenance

Text = Annotated[str, Field(min_length=1, max_length=500)]
ATTESTATIONS = {
    "original-content",
    "contract-clarity",
    "hint-progression",
    "no-solution-code",
    "rubric-not-a-grade",
}
MAX_DRAFT_BYTES = 12_000_000
MAX_JSON_DEPTH = 64


class Lesson(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    problem_id: str
    skill_targets: list[Text] = Field(min_length=1, max_length=6)
    prerequisites: list[str] = Field(default_factory=list, max_length=20)
    recall_prompts: list[Text] = Field(min_length=3, max_length=3)
    practice_modes: list[Literal["guided", "mock"]] = Field(
        default=["guided", "mock"], min_length=1, max_length=2
    )


class DraftManifest(PackContent):
    workflow_stage: Literal["draft"]
    review_status: Literal["unreviewed"]
    ownership: Literal["original"]
    authored_with: Literal["ai-assisted", "human"]
    created_at: datetime
    curriculum: list[Lesson] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def validate_curriculum(self) -> DraftManifest:
        if self.created_at.tzinfo is None:
            raise ValueError("Draft creation needs a UTC offset.")
        ids = {problem.id for problem in self.coding} | {problem.id for problem in self.design}
        seen: set[str] = set()
        for lesson in self.curriculum:
            if lesson.problem_id in seen or lesson.problem_id not in ids:
                raise ValueError("Each practice item needs one unique curriculum lesson.")
            if (
                len(set(lesson.prerequisites)) != len(lesson.prerequisites)
                or not set(lesson.prerequisites) <= seen
            ):
                raise ValueError("Prerequisites must be unique, earlier lessons in this draft.")
            if len(set(lesson.practice_modes)) != len(lesson.practice_modes):
                raise ValueError("Practice modes must not be repeated.")
            if any(not text.strip() for text in [*lesson.skill_targets, *lesson.recall_prompts]):
                raise ValueError("Skills and plain-English recall prompts must not be blank.")
            seen.add(lesson.problem_id)
        if seen != ids:
            raise ValueError("The curriculum must cover every coding/design item exactly once.")
        if any(problem.revision for problem in self.design):
            raise ValueError("Drafts must not claim a previously published design revision.")
        return self


class ReviewApproval(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    format_version: Literal[1]
    decision: Literal["approve-release"]
    content_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    reviewer: str = Field(min_length=1, max_length=200)
    reviewed_at: datetime
    reviewed_ids: list[str] = Field(min_length=1, max_length=200)
    attestations: list[str] = Field(min_length=5, max_length=5)

    @model_validator(mode="after")
    def validate_approval(self) -> ReviewApproval:
        if not self.reviewer.strip() or self.reviewed_at.tzinfo is None:
            raise ValueError("Approval needs a named reviewer and timezone-aware timestamp.")
        if set(self.attestations) != ATTESTATIONS:
            raise ValueError("Approval must cover all five content-review attestations.")
        if len(set(self.reviewed_ids)) != len(self.reviewed_ids):
            raise ValueError("Each reviewed item must appear once.")
        return self


def content_digest(draft: DraftManifest) -> str:
    return hashlib.sha256(
        json.dumps(
            draft.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()


def validation_report(draft: DraftManifest) -> dict[str, object]:
    return {
        "format_version": 1,
        "pack_id": draft.pack_id,
        "version": draft.version,
        "stage": "unreviewed-draft",
        "structural_validation": "passed",
        "publishable": False,
        "content_sha256": content_digest(draft),
        "coding_count": len(draft.coding),
        "design_count": len(draft.design),
        "lesson_order": [lesson.problem_id for lesson in draft.curriculum],
        "limitations": [
            "Structural validation does not prove original ownership or question correctness.",
            "No author-supplied code or reference solution was executed.",
            "Independent content approval has not been supplied.",
            "Self-ratings and design rubrics are not mastery or hiring grades.",
        ],
    }


def compile_release(
    draft: DraftManifest, approval: ReviewApproval, released_at: datetime
) -> PackManifest:
    if approval.content_sha256 != content_digest(draft):
        raise ValueError("Approval is stale or belongs to another draft.")
    ids = {problem.id for problem in draft.coding} | {problem.id for problem in draft.design}
    if set(approval.reviewed_ids) != ids:
        raise ValueError("Approval must cover every practice item, with no extra IDs.")
    if released_at.tzinfo is None or not draft.created_at <= approval.reviewed_at <= released_at:
        raise ValueError("Use timezone-aware creation, review, and release dates in that order.")
    manifest = PackManifest(
        format_version=draft.format_version,
        pack_id=draft.pack_id,
        title=draft.title,
        version=draft.version,
        coding=draft.coding,
        design=draft.design,
        released_at=released_at,
        provenance=Provenance(
            ownership="original",
            review_status="human-reviewed",
            reviewer=approval.reviewer.strip(),
            reviewed_at=approval.reviewed_at,
        ),
    )
    if (
        len(
            json.dumps(
                manifest.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
            ).encode()
        )
        > MAX_DRAFT_BYTES
    ):
        raise ValueError("Release exceeds the signed-payload size limit.")
    return manifest


def _object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON keys are not allowed.")
        result[key] = value
    return result


def _constant(_value: str) -> object:
    raise ValueError("Non-finite JSON numbers are not allowed.")


def read_payload(path: Path, *, limit: int = MAX_DRAFT_BYTES) -> dict[str, object]:
    with path.open("rb") as source:
        contents = source.read(limit + 1)
    if len(contents) > limit:
        raise ValueError("Input exceeds the content size limit.")
    try:
        result = json.loads(contents, object_pairs_hook=_object, parse_constant=_constant)
    except RecursionError:
        raise ValueError("Input JSON is nested too deeply.") from None
    if not isinstance(result, dict):
        raise ValueError("Input must be a JSON object.")
    # Do not depend on the process recursion limit (test runners can change it).
    pending: list[tuple[object, int]] = [(result, 0)]
    while pending:
        value, depth = pending.pop()
        if depth > MAX_JSON_DEPTH:
            raise ValueError("Input JSON is nested too deeply.")
        if isinstance(value, dict):
            pending.extend((child, depth + 1) for child in value.values())
        elif isinstance(value, list):
            pending.extend((child, depth + 1) for child in value)
    return cast("dict[str, object]", result)


def write_artifact(path: Path, payload: dict[str, object]) -> None:
    # Validate/serialize before exclusive creation. Never replace previous releases.
    contents = json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n"
    descriptor, temporary = tempfile.mkstemp(prefix=".curriculum-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf8") as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)
    finally:
        # This exact temporary file belongs to this invocation, never a user draft.
        Path(temporary).unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser(
        "validate", help="Inspect a draft without approval or side effects"
    )
    validate.add_argument("draft", type=Path)
    validate.add_argument("--report", type=Path)
    build = commands.add_parser(
        "build", help="Compile an unsigned manifest from exact content approval"
    )
    build.add_argument("draft", type=Path)
    build.add_argument("--approval", type=Path, required=True)
    build.add_argument("--released-at", required=True)
    build.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        draft = DraftManifest.model_validate(read_payload(args.draft))
        if args.command == "validate":
            report = validation_report(draft)
            if args.report:
                write_artifact(args.report, report)
            print(json.dumps(report, indent=2))
        else:
            approval = ReviewApproval.model_validate(read_payload(args.approval, limit=50_000))
            release = compile_release(draft, approval, datetime.fromisoformat(args.released_at))
            write_artifact(args.output, release.model_dump(mode="json"))
            print("Compiled unsigned manifest; nothing was signed, installed, or published.")
    except ValidationError as error:
        # Do not print private question text or supplied secrets in CLI/CI logs.
        parser.exit(2, f"Content schema validation failed ({error.error_count()} errors).\n")
    except (OSError, ValueError, SyntaxError) as error:
        message = (
            "Cannot read/write artifact; check paths and existing output files."
            if isinstance(error, OSError)
            else "Invalid JSON or content contract."
            if isinstance(error, SyntaxError | json.JSONDecodeError | UnicodeError)
            else str(error)
        )
        parser.exit(2, message + "\n")


if __name__ == "__main__":
    main()
