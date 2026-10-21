from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

from server.db.content import ProblemContent
from server.design.catalog import PROBLEMS
from server.distribution.manifest import PackManifest, validate_starter
from tests.test_repo import SAMPLE_PROBLEM
from tools.curriculum import (
    ATTESTATIONS,
    DraftManifest,
    ReviewApproval,
    compile_release,
    content_digest,
    read_payload,
    validation_report,
    write_artifact,
)

ROOT = Path(__file__).parents[1]


def payload():
    design = PROBLEMS["design-link-aliases"].model_dump(mode="json")
    design.update(id="fixture-lab-design", pack_id="fixture-lab", revision="")
    return {
        "format_version": 1,
        "pack_id": "fixture-lab",
        "title": "Authoring fixture, not commercial content",
        "version": "0.1.0",
        "workflow_stage": "draft",
        "review_status": "unreviewed",
        "ownership": "original",
        "authored_with": "ai-assisted",
        "created_at": "2026-01-01T00:00:00Z",
        "coding": [],
        "design": [design],
        "curriculum": [
            {
                "problem_id": "fixture-lab-design",
                "skill_targets": ["Contract reading"],
                "recall_prompts": [
                    "State your guarantee.",
                    "Trace one failure.",
                    "Explain a tradeoff.",
                ],
                "prerequisites": [],
            }
        ],
    }


def approved(draft, **changes):
    return ReviewApproval.model_validate(
        {
            "format_version": 1,
            "decision": "approve-release",
            "content_sha256": content_digest(draft),
            "reviewer": "Explicit test fixture only, not a real content approval",
            "reviewed_at": "2026-01-02T00:00:00Z",
            "reviewed_ids": [lesson.problem_id for lesson in draft.curriculum],
            "attestations": sorted(ATTESTATIONS),
            **changes,
        }
    )


def test_draft_validation_is_not_a_release_or_approval():
    draft = DraftManifest.model_validate(payload())
    report = validation_report(draft)
    assert report["publishable"] is False
    assert report["stage"] == "unreviewed-draft"
    assert report["design_count"] == 1
    assert len(report["content_sha256"]) == 64
    with pytest.raises(ValueError):
        PackManifest.model_validate(draft.model_dump(mode="json"))


def test_release_compiler_binds_exact_draft_review_and_strips_authoring_metadata():
    draft = DraftManifest.model_validate(payload())
    approval = approved(draft)
    release = compile_release(draft, approval, datetime(2026, 1, 3, tzinfo=UTC))
    data = release.model_dump(mode="json")
    assert data["provenance"]["reviewer"] == approval.reviewer
    assert not {"workflow_stage", "curriculum", "authored_with", "created_at"} & data.keys()
    assert PackManifest.model_validate(data).design[0].id == "fixture-lab-design"
    changed = deepcopy(draft)
    changed.design[0].constraints.append("A changed assumption needs a fresh review.")
    with pytest.raises(ValueError, match="stale"):
        compile_release(changed, approval, datetime(2026, 1, 3, tzinfo=UTC))
    # Lesson/recall content is also review-bound, not only the runtime question text.
    changed = deepcopy(draft)
    changed.curriculum[0].recall_prompts[0] = "Changed recall prompt"
    assert content_digest(changed) != approval.content_sha256


@pytest.mark.parametrize(
    "changes",
    [
        {"reviewed_ids": ["some-other-item"]},
        {"reviewed_at": "2025-12-31T00:00:00Z"},
        {"reviewed_at": "2026-01-04T00:00:00Z"},
    ],
)
def test_partial_wrong_and_out_of_order_approvals_cannot_compile(changes):
    draft = DraftManifest.model_validate(payload())
    with pytest.raises(ValueError):
        compile_release(draft, approved(draft, **changes), datetime(2026, 1, 3, tzinfo=UTC))


@pytest.mark.parametrize(
    "change",
    [
        "duplicate",
        "missing",
        "foreign",
        "self-prerequisite",
        "unknown-prerequisite",
        "blank-recall",
        "published-revision",
        "fake-reviewed",
        "missing-hint",
    ],
)
def test_draft_curriculum_invariants(change):
    value = payload()
    lesson = value["curriculum"][0]
    if change == "duplicate":
        value["curriculum"].append(deepcopy(lesson))
    elif change == "missing":
        value["curriculum"] = []
    elif change == "foreign":
        lesson["problem_id"] = "other-pack-question"
    elif change == "self-prerequisite":
        lesson["prerequisites"] = [lesson["problem_id"]]
    elif change == "unknown-prerequisite":
        lesson["prerequisites"] = ["missing-item"]
    elif change == "blank-recall":
        lesson["recall_prompts"][0] = " "
    elif change == "published-revision":
        value["design"][0]["revision"] = "a" * 64
    elif change == "fake-reviewed":
        value["review_status"] = "human-reviewed"
    elif change == "missing-hint":
        value["design"][0]["hints"].pop()
    with pytest.raises(ValueError):
        DraftManifest.model_validate(value)


def test_every_approval_attestation_is_required():
    draft = DraftManifest.model_validate(payload())
    with pytest.raises(ValueError):
        approved(draft, attestations=["original-content"])
    with pytest.raises(ValueError):
        approved(draft, reviewer=" ")


@pytest.mark.parametrize(
    "starter",
    [
        "def answer(value=__import__('os').system('not-executed')): pass",
        "def answer(value: __import__('os').system('not-executed')): pass",
        "def answer[T: __import__('os').system('not-executed')](): pass",
        "def answer(*, required): pass",
    ],
)
def test_starter_validation_never_executes_header_expressions(starter):
    problem = ProblemContent.model_validate(
        {
            **SAMPLE_PROBLEM,
            "starter_code": {"python": starter},
            "test_cases": {"python": [{"input": [], "expected": 1}]},
        }
    )
    with pytest.raises(ValueError):
        validate_starter(problem)


def test_safe_starter_annotations_and_positional_fixture_arity():
    problem = ProblemContent.model_validate(
        {
            **SAMPLE_PROBLEM,
            "starter_code": {
                "python": "def answer(values: list[int], limit: int | None = None) -> int: pass"
            },
            "test_cases": {"python": [{"input": [[1, 2]], "expected": 1}]},
        }
    )
    validate_starter(problem)
    problem.test_cases["python"][0].input = []
    with pytest.raises(ValueError, match="argument counts"):
        validate_starter(problem)


@pytest.mark.parametrize("content", ['{"a": 1, "a": 2}', '{"a": NaN}', "[]"])
def test_ambiguous_nonfinite_and_nonobject_json_is_rejected(tmp_path, content):
    path = tmp_path / "invalid.json"
    path.write_text(content)
    with pytest.raises(ValueError):
        read_payload(path)
    path.write_text('{"a": "too long"}')
    with pytest.raises(ValueError, match="size"):
        read_payload(path, limit=2)


def test_artifacts_are_exclusive_private_and_no_partial_file_survives_failed_sync(
    tmp_path, monkeypatch
):
    output = tmp_path / "release.json"
    write_artifact(output, {"safe": True})
    with pytest.raises(FileExistsError):
        write_artifact(output, {"replacement": True})
    assert json.loads(output.read_text()) == {"safe": True}
    if os.name != "nt":
        assert output.stat().st_mode & 0o777 == 0o600
    with monkeypatch.context() as context:
        context.setattr(
            os, "fsync", lambda _fd: (_ for _ in ()).throw(OSError("fixture disk failure"))
        )
        with pytest.raises(OSError):
            write_artifact(tmp_path / "failed.json", {"safe": True})
    assert not (tmp_path / "failed.json").exists()
    assert sorted(path.name for path in tmp_path.iterdir()) == ["release.json"]


def test_real_cli_is_read_only_unless_report_requested_and_never_initializes_database(tmp_path):
    source = tmp_path / "draft.json"
    source.write_text(json.dumps(payload()))
    original = source.read_bytes()
    database = tmp_path / "must-not-create-db"
    result = subprocess.run(
        [sys.executable, "-m", "tools.curriculum", "validate", str(source)],
        cwd=ROOT,
        env={**os.environ, "INTERVIEW_MCP_DB_DIR": str(database)},
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["publishable"] is False
    assert not database.exists()
    assert source.read_bytes() == original
    assert sorted(path.name for path in tmp_path.iterdir()) == ["draft.json"]
    invalid = payload()
    invalid["title"] = 42
    invalid["private-note"] = "fixture-private-content-must-not-appear"
    source.write_text(json.dumps(invalid))
    result = subprocess.run(
        [sys.executable, "-m", "tools.curriculum", "validate", str(source)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 2
    assert "fixture-private-content" not in result.stderr


def test_real_cli_build_requires_external_exact_approval_and_never_overwrites(tmp_path):
    draft = DraftManifest.model_validate(payload())
    source, review, output = (
        tmp_path / name for name in ["draft.json", "review.json", "release.json"]
    )
    source.write_text(draft.model_dump_json())
    review.write_text(approved(draft).model_dump_json())
    command = [
        sys.executable,
        "-m",
        "tools.curriculum",
        "build",
        str(source),
        "--approval",
        str(review),
        "--released-at",
        "2026-01-03T00:00:00Z",
        "--output",
        str(output),
    ]
    first = subprocess.run(
        command, cwd=ROOT, capture_output=True, text=True, timeout=15, check=False
    )
    assert first.returncode == 0, first.stderr
    existing = output.read_bytes()
    assert PackManifest.model_validate_json(existing).pack_id == draft.pack_id
    second = subprocess.run(
        command, cwd=ROOT, capture_output=True, text=True, timeout=15, check=False
    )
    assert second.returncode == 2
    assert output.read_bytes() == existing


def test_compiled_fixture_signs_and_installs_through_real_sqlalchemy_without_authoring_data(
    tmp_path, monkeypatch
):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from server.db import base
    from server.db.base import Base
    from server.design import catalog
    from server.distribution import packs
    from tools.distribution import sign_payload

    engine = create_engine(f"sqlite:///{tmp_path / 'fixture.sqlite'}")
    Base.metadata.create_all(engine)
    monkeypatch.setattr(base, "engine", engine)
    monkeypatch.setattr(base, "SessionLocal", sessionmaker(bind=engine))
    monkeypatch.setattr(packs, "current_user_id", lambda: "local")
    key = Ed25519PrivateKey.generate()
    public = key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()
    monkeypatch.setattr(packs, "trust_config", lambda: {"contentPublicKey": public})
    draft = DraftManifest.model_validate(payload())
    manifest = compile_release(draft, approved(draft), datetime(2026, 1, 3, tzinfo=UTC))
    # These are explicit test-only claims, not a customer purchase or a real review.
    license_claims = {
        "format_version": 1,
        "license_id": str(uuid4()),
        "pack_id": draft.pack_id,
        "subject": "fixture-owner",
        "issued_at": "2026-01-01T00:00:00Z",
        "updates_until": "2026-02-01T00:00:00Z",
        "perpetual": True,
    }
    try:
        result = packs.install(
            sign_payload(manifest.model_dump(mode="json"), key), sign_payload(license_claims, key)
        )
        assert result["design_count"] == 1
        assert catalog.get_problem("fixture-lab-design").title == draft.design[0].title
        installed = packs.active_manifests()[0].model_dump(mode="json")
        assert "curriculum" not in installed
        assert "workflow_stage" not in installed
    finally:
        engine.dispose()


def test_real_signing_cli_uses_external_test_key_and_preserves_existing_artifact(tmp_path):
    draft = DraftManifest.model_validate(payload())
    manifest = compile_release(draft, approved(draft), datetime(2026, 1, 3, tzinfo=UTC))
    source = tmp_path / "manifest.json"
    source.write_text(manifest.model_dump_json())
    # Ephemeral test-only key, never a production trust key or actual content signature.
    key = Ed25519PrivateKey.generate()
    private = tmp_path / "fixture-key.pem"
    private.write_bytes(key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()))
    private.chmod(0o600)
    output = tmp_path / "signed-fixture.json"
    database = tmp_path / "must-not-create-db"
    command = [
        sys.executable,
        "-m",
        "tools.distribution",
        "pack",
        "--private-key",
        str(private),
        "--manifest",
        str(source),
        "--output",
        str(output),
    ]
    first = subprocess.run(
        command,
        cwd=ROOT,
        env={**os.environ, "INTERVIEW_MCP_DB_DIR": str(database)},
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert first.returncode == 0, first.stderr
    assert not database.exists()
    envelope = json.loads(output.read_text())
    content = base64.b64decode(envelope["payload"], validate=True)
    key.public_key().verify(base64.b64decode(envelope["signature"], validate=True), content)
    assert json.loads(content) == manifest.model_dump(mode="json")
    existing = output.read_bytes()
    second = subprocess.run(
        command, cwd=ROOT, capture_output=True, text=True, timeout=15, check=False
    )
    assert second.returncode == 2
    assert "Traceback" not in second.stderr
    assert output.read_bytes() == existing
    assert source.read_text() == manifest.model_dump_json()
    assert not list(tmp_path.glob(".curriculum-*.tmp"))


def test_signing_cli_rejects_repository_keys_before_reading_them(tmp_path):
    output = tmp_path / "must-not-exist.json"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "tools.distribution",
            "license",
            "--private-key",
            str(ROOT / "nonexistent-fixture-key.pem"),
            "--pack-id",
            "fixture-lab",
            "--subject",
            "fixture-owner",
            "--output",
            str(output),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert result.returncode == 2
    assert "outside the repository" in result.stderr
    assert not output.exists()


def test_nested_json_and_nonfinite_signing_inputs_fail_without_tracebacks(tmp_path):
    from tools.distribution import sign_payload

    source = tmp_path / "nested.json"
    source.write_text('{"a":' + "[" * 2000 + "0" + "]" * 2000 + "}")
    with pytest.raises(ValueError, match="nested too deeply"):
        read_payload(source)
    with pytest.raises(ValueError):
        sign_payload({"bad": float("inf")}, Ed25519PrivateKey.generate())
