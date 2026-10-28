from __future__ import annotations

import base64
import json
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from pydantic import BaseModel, ConfigDict, Field


class SignedEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")
    payload: str = Field(max_length=16_000_000)
    signature: str = Field(max_length=128)


def trust_config() -> dict[str, str]:
    raw = json.loads(Path(__file__).with_name("trust.json").read_text())
    return {
        key: str(raw.get(key, ""))
        for key in ("releasePublicKey", "contentPublicKey", "checkoutUrl")
    }


def verify_envelope(value: str, public_key: str, *, limit: int = 12_000_000) -> dict[str, object]:
    if not public_key:
        raise ValueError("Content signing is not configured in this preview build.")
    if len(value.encode()) > limit * 2:
        raise ValueError("Signed package is too large.")
    try:
        envelope = SignedEnvelope.model_validate_json(value)
        payload = base64.b64decode(envelope.payload, validate=True)
        signature = base64.b64decode(envelope.signature, validate=True)
        if len(payload) > limit or len(signature) != 64:
            raise ValueError("Invalid signed package size.")
        key = load_pem_public_key(public_key.encode())
        if not isinstance(key, Ed25519PublicKey):
            raise ValueError("An Ed25519 public key is required.")
        key.verify(signature, payload)
        result = json.loads(payload)
        if not isinstance(result, dict):
            raise ValueError("Signed payload must be an object.")
        return result
    except (ValueError, InvalidSignature) as exc:
        raise ValueError("Package signature or format is invalid.") from exc
