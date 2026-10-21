"""Portable owned practice data; never exports bearer keys or credentials."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select

from server.core.identity import current_user_id
from server.db.base import get_session
from server.db.models import (
    Attempt,
    ContentPackVersion,
    DesignCheckpoint,
    DesignReviewRecord,
    DesignSession,
    Event,
    PracticeQueueItem,
    PracticeReflection,
)
from server.db.schema_version import SCHEMA_VERSION


def _record(
    row: Attempt
    | Event
    | DesignSession
    | DesignCheckpoint
    | DesignReviewRecord
    | ContentPackVersion
    | PracticeQueueItem
    | PracticeReflection,
) -> dict[str, object]:
    result: dict[str, object] = {}
    for column in row.__table__.columns:
        if column.name == "user_id":
            continue
        value = getattr(row, column.name)
        if isinstance(value, datetime):
            value = (value if value.tzinfo else value.replace(tzinfo=UTC)).isoformat()
        result[column.name] = value
    return result


def export_data() -> dict[str, object]:
    with get_session() as session:
        attempts = list(
            session.scalars(select(Attempt).where(Attempt.user_id == current_user_id()))
        )
        attempt_ids = [row.id for row in attempts]
        designs = list(
            session.scalars(select(DesignSession).where(DesignSession.user_id == current_user_id()))
        )
        design_ids = [row.id for row in designs]
        checkpoints = list(
            session.scalars(
                select(DesignCheckpoint).where(DesignCheckpoint.session_id.in_(design_ids))
            )
        )
        checkpoint_ids = [row.id for row in checkpoints]
        return {
            "format_version": 1,
            "schema_version": SCHEMA_VERSION,
            "attempts": [_record(row) for row in attempts],
            "events": [
                _record(row)
                for row in session.scalars(select(Event).where(Event.attempt_id.in_(attempt_ids)))
            ],
            "design_sessions": [_record(row) for row in designs],
            "design_checkpoints": [_record(row) for row in checkpoints],
            "design_reviews": [
                _record(row)
                for row in session.scalars(
                    select(DesignReviewRecord).where(
                        DesignReviewRecord.checkpoint_id.in_(checkpoint_ids)
                    )
                )
            ],
            "practice_queue": [
                _record(row)
                for row in session.scalars(
                    select(PracticeQueueItem).where(PracticeQueueItem.user_id == current_user_id())
                )
            ],
            "practice_reflections": [
                _record(row)
                for row in session.scalars(
                    select(PracticeReflection)
                    .join(PracticeQueueItem, PracticeReflection.item_id == PracticeQueueItem.id)
                    .where(PracticeQueueItem.user_id == current_user_id())
                )
            ],
            "content_pack_versions": [
                _record(row) for row in session.scalars(select(ContentPackVersion))
            ]
            if current_user_id() == "local"
            else [],
        }
