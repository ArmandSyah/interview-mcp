"""Content fingerprints and immutable attempt snapshots."""

from __future__ import annotations

import hashlib
import json

from server.db.schemas import ProblemRead


def snapshot_problem(problem: ProblemRead) -> tuple[dict[str, object], str]:
    snapshot = problem.model_dump(mode="json")
    content = {
        key: value for key, value in snapshot.items() if key not in {"created_at", "updated_at"}
    }
    serialized = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return snapshot, hashlib.sha256(serialized.encode("utf-8")).hexdigest()
