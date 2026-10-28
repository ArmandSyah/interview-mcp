"""Owner-operated signing: no hosted service, payment API or automatic fulfillment."""

from __future__ import annotations

import argparse
import base64
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import load_pem_private_key
from pydantic import ValidationError

from server.distribution.manifest import LicenseClaims, PackManifest
from tools.curriculum import read_payload, write_artifact


def sign_payload(payload: dict[str, object], private_key: Ed25519PrivateKey) -> str:
    content = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return json.dumps(
        {
            "payload": base64.b64encode(content).decode(),
            "signature": base64.b64encode(private_key.sign(content)).decode(),
        }
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=["pack", "license"])
    parser.add_argument("--private-key", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--pack-id")
    parser.add_argument("--subject")
    parser.add_argument("--update-days", type=int, default=90)
    args = parser.parse_args()
    try:
        repository = Path(__file__).resolve().parents[1]
        if args.private_key.resolve().is_relative_to(repository):
            parser.error("Signing keys must remain outside the repository and installer inputs.")
        if args.kind == "pack":
            if not args.manifest:
                parser.error("--manifest is required for pack signing.")
            payload = PackManifest.model_validate(read_payload(args.manifest)).model_dump(
                mode="json"
            )
        else:
            if not args.pack_id or not args.subject or not 0 <= args.update_days <= 3650:
                parser.error("Licenses require --pack-id, --subject and 0-3650 --update-days.")
            now = datetime.now(UTC)
            payload = LicenseClaims(
                format_version=1,
                license_id=uuid4(),
                pack_id=args.pack_id,
                subject=args.subject,
                issued_at=now,
                updates_until=now + timedelta(days=args.update_days),
                perpetual=True,
            ).model_dump(mode="json")
        key = load_pem_private_key(args.private_key.read_bytes(), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            parser.error("Use an Ed25519 signing key stored outside the repository.")
        # Never replace an earlier release or leave a partially written signed envelope.
        write_artifact(args.output, json.loads(sign_payload(payload, key)))
    except ValidationError as error:
        parser.exit(2, f"Content schema validation failed ({error.error_count()} errors).\n")
    except (OSError, ValueError, TypeError):
        # Private draft text and key bytes must not appear in terminal/CI errors.
        parser.exit(2, "Signing failed; check input contracts, key, and unused output path.\n")


if __name__ == "__main__":
    main()
