"""Signed original packs: atomic SQLAlchemy installs and perpetual offline licenses."""

from __future__ import annotations

import hashlib
import json

from sqlalchemy import select, update
from sqlalchemy.dialects.sqlite import insert

from server.core.identity import current_user_id
from server.db.base import get_session
from server.db.models import ContentPackVersion, Problem
from server.distribution.manifest import LicenseClaims as LicenseClaims
from server.distribution.manifest import PackManifest as PackManifest
from server.distribution.signatures import trust_config, verify_envelope


def _version(value: str) -> tuple[int, ...]:
    return tuple(map(int, value.split(".")))


def installed() -> list[dict[str, object]]:
    with get_session() as session:
        return [
            {
                "pack_id": row.pack_id,
                "title": row.manifest["title"],
                "version": row.version,
                "revision": row.revision,
                "updates_until": row.license_claims["updates_until"],
                "perpetual": True,
            }
            for row in session.scalars(
                select(ContentPackVersion).where(ContentPackVersion.active.is_(True))
            )
        ]


def active_manifests() -> list[PackManifest]:
    with get_session() as session:
        return [
            PackManifest.model_validate(row.manifest)
            for row in session.scalars(
                select(ContentPackVersion).where(ContentPackVersion.active.is_(True))
            )
        ]


def install(package_json: str, license_json: str) -> dict[str, object]:
    if current_user_id() != "local":
        raise ValueError("Content packs can only be installed in a local workspace.")
    key = trust_config()["contentPublicKey"]
    pack = PackManifest.model_validate(verify_envelope(package_json, key))
    license_claims = LicenseClaims.model_validate(verify_envelope(license_json, key, limit=10_000))
    if license_claims.pack_id != pack.pack_id:
        raise ValueError("This license is for a different pack.")
    if license_claims.issued_at.tzinfo is None or license_claims.updates_until.tzinfo is None:
        raise ValueError("License dates need UTC offsets.")
    if license_claims.updates_until < license_claims.issued_at:
        raise ValueError("License update window is invalid.")
    # Expiry bounds new releases, not use of purchased content. Never phone home.
    if pack.released_at > license_claims.updates_until:
        raise ValueError("This release is outside your licensed update window.")
    manifest = pack.model_dump(mode="json")
    revision = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    with get_session() as session:
        from server.design.catalog import PROBLEMS

        ids = {problem.id for problem in pack.coding} | {problem.id for problem in pack.design}
        if ids.intersection(PROBLEMS):
            raise ValueError("A content pack cannot replace a built-in design brief.")
        existing = list(
            session.scalars(
                select(ContentPackVersion).where(ContentPackVersion.pack_id == pack.pack_id)
            )
        )
        owned_ids = {
            problem.id
            for row in existing
            for problem in PackManifest.model_validate(row.manifest).coding
        }
        for coding in pack.coding:
            if session.get(Problem, coding.id) is not None and coding.id not in owned_ids:
                raise ValueError("A content pack cannot replace another catalog's question.")
        for other in session.scalars(
            select(ContentPackVersion).where(ContentPackVersion.pack_id != pack.pack_id)
        ):
            content = PackManifest.model_validate(other.manifest)
            if ids.intersection(
                {problem.id for problem in content.coding}
                | {problem.id for problem in content.design}
            ):
                raise ValueError("A content pack cannot replace another pack's content.")
        for row in existing:
            if row.version == pack.version and row.revision != revision:
                raise ValueError("A published pack version is immutable.")
            if row.active and _version(row.version) > _version(pack.version):
                raise ValueError("Pack downgrades are not supported; saved attempts remain pinned.")
        coding_ids = {problem.id for problem in pack.coding}
        for row in existing:
            if row.active:
                old = PackManifest.model_validate(row.manifest)
                removed = {problem.id for problem in old.coding} - coding_ids
                if removed:
                    session.execute(
                        update(Problem).where(Problem.id.in_(removed)).values(available=False)
                    )
                row.active = False
        for problem in pack.coding:
            values = problem.model_dump()
            session.execute(
                insert(Problem)
                .values(**values, available=True)
                .on_conflict_do_update(index_elements=["id"], set_={**values, "available": True})
            )
        installed_row = session.get(ContentPackVersion, revision)
        if installed_row is None:
            installed_row = ContentPackVersion(
                revision=revision,
                pack_id=pack.pack_id,
                version=pack.version,
                manifest=manifest,
                license_claims=license_claims.model_dump(mode="json"),
            )
            session.add(installed_row)
        installed_row.active = True
        installed_row.license_claims = license_claims.model_dump(mode="json")
        installed_row.signed_package = package_json
        installed_row.signed_license = license_json
    return {
        "pack_id": pack.pack_id,
        "version": pack.version,
        "revision": revision,
        "coding_count": len(pack.coding),
        "design_count": len(pack.design),
    }
