from __future__ import annotations

import base64
import json
from copy import deepcopy
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from server.db import base, repo
from server.db.base import Base
from server.db.models import ContentPackVersion
from server.design import catalog
from server.design import repo as design_repo
from server.distribution import packs
from server.distribution.backup import export_data
from tests.test_repo import SAMPLE_PROBLEM
from tools.distribution import sign_payload


@pytest.fixture(autouse=True)
def database(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    monkeypatch.setattr(base, "engine", engine)
    monkeypatch.setattr(base, "SessionLocal", sessionmaker(bind=engine, autoflush=False))
    yield engine
    engine.dispose()


@pytest.fixture
def signed(monkeypatch):
    key = Ed25519PrivateKey.generate()
    public = key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()
    monkeypatch.setattr(packs, "trust_config", lambda: {"contentPublicKey": public})
    return lambda value: sign_payload(value, key)


def manifest(version="1.0.0"):
    problem = {
        **deepcopy(SAMPLE_PROBLEM),
        "id": "original-test-pair",
        "fallback_hints": ["First", "Second", "Third"],
        "test_cases": {"python": [{"input": [], "expected": 1}]},
    }
    design = catalog.get_problem("design-link-aliases").model_dump(mode="json")
    design.update(id="original-test-aliases", pack_id="original-test", revision="")
    return {
        "format_version": 1,
        "pack_id": "original-test",
        "title": "Fixture original pack",
        "version": version,
        "released_at": "2026-01-01T00:00:00Z",
        "provenance": {
            "ownership": "original",
            "review_status": "human-reviewed",
            "reviewer": "Test fixture reviewer, not production approval",
            "reviewed_at": "2025-12-30T00:00:00Z",
        },
        "coding": [problem],
        "design": [design],
    }


def license_claims():
    return {
        "format_version": 1,
        "license_id": str(uuid4()),
        "pack_id": "original-test",
        "subject": "fixture-owner",
        "issued_at": "2025-12-01T00:00:00Z",
        "updates_until": "2026-03-01T00:00:00Z",
        "perpetual": True,
    }


def test_signed_pack_is_installed_offline_even_after_update_window(signed):
    # The update window has ended; the licensed release remains usable forever.
    assert datetime.now(UTC).year >= 2026
    result = packs.install(signed(manifest()), signed(license_claims()))
    assert result["coding_count"] == result["design_count"] == 1
    assert repo.get_problem("original-test-pair").title == SAMPLE_PROBLEM["title"]
    assert len(catalog.summaries()) == 6
    assert len(catalog.get_problem("original-test-aliases").revision) == 64
    assert packs.installed()[0]["perpetual"] is True


def test_updates_are_atomic_and_attempts_remain_pinned(signed, database):
    first = manifest()
    license_json = signed(license_claims())
    packs.install(signed(first), license_json)
    coding = repo.create_attempt("original-test-pair", "python")
    design = design_repo.start("original-test-aliases")
    second = manifest("1.1.0")
    second["coding"][0]["title"] = "Updated title"
    second["design"][0]["title"] = "Updated design title"
    packs.install(signed(second), license_json)
    assert repo.get_problem("original-test-pair").title == "Updated title"
    assert repo.get_attempt_problem(coding.id).title == SAMPLE_PROBLEM["title"]
    assert design_repo.get(design.id).brief.title == "Link Alias Service"
    assert catalog.get_problem("original-test-aliases").title == "Updated design title"
    with Session(database) as session:
        versions = list(session.scalars(select(ContentPackVersion)))
        assert len(versions) == 2
        assert sum(row.active for row in versions) == 1


def test_failed_database_commit_rolls_back_catalog_and_pack(signed, monkeypatch):
    packs.install(signed(manifest()), signed(license_claims()))
    before = packs.installed()
    update = manifest("1.1.0")
    update["coding"][0]["title"] = "Must not be installed"
    with monkeypatch.context() as patch:
        patch.setattr(Session, "commit", lambda _self: (_ for _ in ()).throw(OSError("disk full")))
        with pytest.raises(OSError, match="disk full"):
            packs.install(signed(update), signed(license_claims()))
    assert packs.installed() == before
    assert repo.get_problem("original-test-pair").title == SAMPLE_PROBLEM["title"]


def test_tampering_wrong_license_and_unlicensed_updates_are_rejected(signed):
    envelope = json.loads(signed(manifest()))
    envelope["payload"] = base64.b64encode(json.dumps({"modified": True}).encode()).decode()
    with pytest.raises(ValueError, match="signature"):
        packs.install(json.dumps(envelope), signed(license_claims()))
    claims = {**license_claims(), "pack_id": "another-pack"}
    with pytest.raises(ValueError, match="different pack"):
        packs.install(signed(manifest()), signed(claims))
    future = {**manifest(), "released_at": "2026-05-01T00:00:00Z"}
    with pytest.raises(ValueError, match="update window"):
        packs.install(signed(future), signed(license_claims()))
    assert packs.installed() == []


def test_published_versions_are_immutable_and_cannot_be_downgraded(signed):
    packs.install(signed(manifest()), signed(license_claims()))
    changed = manifest()
    changed["coding"][0]["title"] = "Changed same version"
    with pytest.raises(ValueError, match="immutable"):
        packs.install(signed(changed), signed(license_claims()))
    packs.install(signed(manifest("2.0.0")), signed(license_claims()))
    with pytest.raises(ValueError, match="downgrades"):
        packs.install(signed(manifest()), signed(license_claims()))


def test_no_unreviewed_copied_or_executable_starter_content(signed):
    for section, key, value in [
        ("provenance", "ownership", "copied"),
        ("provenance", "review_status", "draft"),
    ]:
        invalid = manifest()
        invalid[section][key] = value
        with pytest.raises(ValueError):
            packs.install(signed(invalid), signed(license_claims()))
    invalid = manifest()
    invalid["coding"][0]["starter_code"] = {"python": "import os\ndef answer(): pass"}
    with pytest.raises(ValueError, match="one undecorated"):
        packs.install(signed(invalid), signed(license_claims()))


def test_namespaces_cannot_replace_builtins_and_remote_users_cannot_install(signed, monkeypatch):
    repo.upsert_problem({**SAMPLE_PROBLEM, "id": "original-test-pair"})
    with pytest.raises(ValueError, match="another catalog"):
        packs.install(signed(manifest()), signed(license_claims()))
    monkeypatch.setattr(packs, "current_user_id", lambda: "remote-user")
    with pytest.raises(ValueError, match="local workspace"):
        packs.install(signed(manifest()), signed(license_claims()))


def test_signing_unconfigured_fails_closed(monkeypatch):
    monkeypatch.setattr(packs, "trust_config", lambda: {"contentPublicKey": ""})
    with pytest.raises(ValueError, match="not configured"):
        packs.install("{}", "{}")


def test_portable_backup_preserves_signed_packs_but_never_keys(signed, monkeypatch):
    packs.install(signed(manifest()), signed(license_claims()))
    repo.create_attempt("original-test-pair", "python")
    design_repo.start("original-test-aliases")
    with base.get_session() as session:
        from server.db.models import ApiKey

        session.add(ApiKey(key_hash="secret-bearer-hash", user_id="local"))
    backup = export_data()
    assert backup["schema_version"] == 4
    assert len(backup["attempts"]) == 1
    assert len(backup["design_sessions"]) == 1
    archived = backup["content_pack_versions"][0]
    assert archived["signed_package"]
    assert archived["signed_license"]
    assert "secret-bearer-hash" not in json.dumps(backup)
    monkeypatch.setattr("server.distribution.backup.current_user_id", lambda: "another-user")
    foreign = export_data()
    assert foreign["attempts"] == foreign["design_sessions"] == []
    assert foreign["content_pack_versions"] == []
