"""Revocable, per-user bearer keys. Only key hashes are persisted."""

from __future__ import annotations

import argparse
import hashlib
import re
import secrets

import anyio
from fastmcp.server.auth import AccessToken, TokenVerifier
from sqlalchemy import select

from server.db.base import get_session, initialize_database
from server.db.models import ApiKey

_USER_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}")


def key_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_key(user_id: str) -> str:
    if not _USER_ID.fullmatch(user_id) or user_id == "local":
        raise ValueError(
            "Use a user ID of 1-64 letters, numbers, underscores or hyphens, not 'local'."
        )
    token = "imcp_" + secrets.token_urlsafe(32)
    with get_session() as session:
        session.add(ApiKey(key_hash=key_hash(token), user_id=user_id))
    return token


def revoke_key(digest: str) -> bool:
    with get_session() as session:
        key = session.get(ApiKey, digest)
        if key is None:
            return False
        key.revoked = True
        return True


def _lookup_user(token: str) -> str | None:
    if not token.startswith("imcp_") or len(token) > 128:
        return None
    with get_session() as session:
        key = session.get(ApiKey, key_hash(token))
        return key.user_id if key is not None and not key.revoked else None


class DatabaseTokenVerifier(TokenVerifier):
    async def verify_token(self, token: str) -> AccessToken | None:
        user_id = await anyio.to_thread.run_sync(_lookup_user, token)
        if user_id is None:
            return None
        return AccessToken(token=token, client_id=user_id, scopes=["practice"])


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage interview-mcp access keys on the server.")
    subcommands = parser.add_subparsers(dest="command", required=True)
    create = subcommands.add_parser("create-key", help="Print a new key once; store it securely.")
    create.add_argument("user_id")
    revoke = subcommands.add_parser("revoke-key", help="Revoke by SHA-256 hash from list-keys.")
    revoke.add_argument("key_hash")
    subcommands.add_parser("list-keys", help="List user IDs and hashes, never raw keys.")
    args = parser.parse_args()
    initialize_database()
    if args.command == "create-key":
        print(create_key(args.user_id))
    elif args.command == "revoke-key":
        if not revoke_key(args.key_hash):
            parser.error("Key hash not found.")
        print("Key revoked.")
    else:
        with get_session() as session:
            for key in session.scalars(select(ApiKey).order_by(ApiKey.created_at)):
                print(f"{key.user_id}\t{key.key_hash}\t{'revoked' if key.revoked else 'active'}")


if __name__ == "__main__":
    main()
