"""SQLAlchemy persistence for owned, immutable system-design evidence."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from typing import Literal, cast
from uuid import UUID, uuid4

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from server.core.identity import current_user_id
from server.db.base import get_session
from server.db.models import DesignCheckpoint, DesignReviewRecord, DesignSession
from server.design import catalog
from server.design.schemas import (
    MAX_DIAGRAM_ELEMENTS,
    MAX_DIAGRAM_SUMMARY_BYTES,
    DesignCheckpointRead,
    DesignProblem,
    DesignReview,
    DesignSessionRead,
    DiagramElement,
    ReviewItem,
)

NOTE_KEYS = {"requirements", "api", "data", "capacity", "tradeoffs", "failure_modes"}


def _timestamp(value: datetime) -> datetime:
    # SQLite's DateTime returns naive UTC. MCP's date-time schema requires an offset.
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _owned(session: Session, session_id: str) -> DesignSession:
    row = session.get(DesignSession, session_id)
    if row is None or row.user_id != current_user_id():
        raise ValueError("Design session not found.")
    return row


def _read(row: DesignSession) -> DesignSessionRead:
    problem = DesignProblem.model_validate(row.problem_snapshot)
    return DesignSessionRead(
        id=row.id,
        problem_id=row.problem_id,
        brief=catalog.brief(problem),
        status=cast("Literal['in_progress', 'completed']", row.status),
        started_at=_timestamp(row.started_at),
        completed_at=_timestamp(row.completed_at) if row.completed_at else None,
    )


def _checkpoint_read(row: DesignCheckpoint) -> DesignCheckpointRead:
    return DesignCheckpointRead.model_validate(
        {
            "id": row.id,
            "session_id": row.session_id,
            "label": row.label,
            "scene_digest": row.scene_digest,
            "notes": row.notes,
            "diagram": row.diagram,
            "created_at": _timestamp(row.created_at),
        }
    )


def start(problem_id: str) -> DesignSessionRead:
    problem = catalog.get_problem(problem_id)
    with get_session() as session:
        row = DesignSession(
            id=str(uuid4()),
            user_id=current_user_id(),
            problem_id=problem.id,
            problem_snapshot=problem.model_dump(mode="json"),
            status="in_progress",
            started_at=datetime.now(UTC),
        )
        session.add(row)
        session.flush()
        return _read(row)


def get(session_id: str) -> DesignSessionRead:
    with get_session() as session:
        return _read(_owned(session, session_id))


def save_checkpoint(
    session_id: str,
    checkpoint_id: str,
    scene_digest: str,
    notes: dict[str, str],
    diagram: list[DiagramElement],
    label: str = "Checkpoint",
) -> DesignCheckpointRead:
    UUID(checkpoint_id)
    if not re.fullmatch(r"[a-f0-9]{64}", scene_digest):
        raise ValueError("Invalid scene fingerprint.")
    if set(notes) - NOTE_KEYS or any(len(value) > 5000 for value in notes.values()):
        raise ValueError("Use the six design-note sections, at most 5000 characters each.")
    if (
        len(diagram) > MAX_DIAGRAM_ELEMENTS
        or len(
            json.dumps(
                [item.model_dump() for item in diagram],
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode()
        )
        > MAX_DIAGRAM_SUMMARY_BYTES
    ):
        raise ValueError("Diagram summary is too large.")
    if not 1 <= len(label.strip()) <= 80:
        raise ValueError("Checkpoint label must contain 1-80 characters.")
    with get_session() as session:
        row = _owned(session, session_id)
        if row.status != "in_progress":
            raise ValueError("Start a new practice session to add evidence after finishing.")
        existing = session.get(DesignCheckpoint, checkpoint_id)
        normalized_notes = {key: notes.get(key, "") for key in sorted(NOTE_KEYS)}
        normalized_diagram = [item.model_dump(mode="json") for item in diagram]
        if existing is not None:
            if (
                existing.session_id != session_id
                or existing.scene_digest != scene_digest
                or existing.notes != normalized_notes
                or [
                    DiagramElement.model_validate(item).model_dump(mode="json")
                    for item in existing.diagram
                ]
                != normalized_diagram
                or existing.label != label.strip()
            ):
                raise ValueError("A checkpoint is immutable; create a new revision.")
            return _checkpoint_read(existing)
        checkpoint = DesignCheckpoint(
            id=checkpoint_id,
            session_id=session_id,
            scene_digest=scene_digest,
            notes=normalized_notes,
            diagram=normalized_diagram,
            label=label.strip(),
            created_at=datetime.now(UTC),
        )
        session.add(checkpoint)
        session.flush()
        return _checkpoint_read(checkpoint)


def checkpoints(session_id: str, limit: int = 100) -> list[DesignCheckpointRead]:
    if not 1 <= limit <= 500:
        raise ValueError("Checkpoint limit must be between 1 and 500.")
    with get_session() as session:
        _owned(session, session_id)
        rows = session.scalars(
            select(DesignCheckpoint)
            .where(DesignCheckpoint.session_id == session_id)
            .order_by(DesignCheckpoint.created_at.desc())
            .limit(limit)
        )
        return [_checkpoint_read(row) for row in rows]


def checkpoint(session_id: str, checkpoint_id: str) -> DesignCheckpointRead:
    with get_session() as session:
        _owned(session, session_id)
        row = session.get(DesignCheckpoint, checkpoint_id)
        if row is None or row.session_id != session_id:
            raise ValueError("Design checkpoint not found.")
        return _checkpoint_read(row)


def hint(session_id: str, depth: int) -> dict[str, object]:
    if not 1 <= depth <= 3:
        raise ValueError("Hint depth must be between 1 and 3.")
    with get_session() as session:
        problem = DesignProblem.model_validate(_owned(session, session_id).problem_snapshot)
        return {"hint": problem.hints[depth - 1], "depth": depth, "source": "curated"}


def evaluate(session_id: str, checkpoint_id: str) -> DesignReview:
    evidence = checkpoint(session_id, checkpoint_id)
    problem = get(session_id).brief
    items: list[ReviewItem] = []
    for criterion in problem.rubric:
        text = evidence.notes.get(criterion.key, "").strip()
        items.append(
            ReviewItem(
                key=criterion.key,
                title=criterion.title,
                status="not_discussed"
                if not text
                else "needs_explanation"
                if len(text) < 60
                else "discussed",
                evidence=text[:300],
                question=criterion.prompt,
            )
        )
    reviewed = sum(item.status == "discussed" for item in items)
    review = DesignReview(
        checkpoint_id=checkpoint_id,
        scene_digest=evidence.scene_digest,
        rubric_version=problem.revision,
        items=items,
        summary=(
            f"{reviewed}/6 sections contain at least 60 characters of explanation. "
            "Review the questions against your diagram."
        ),
        limitations=(
            "This offline rubric checks discussion coverage, not architectural correctness "
            "or hiring readiness. A filled section can still be wrong; "
            "there is no single required diagram."
        ),
    )
    with get_session() as session:
        _owned(session, session_id)
        session.add(
            DesignReviewRecord(
                id=str(uuid4()),
                checkpoint_id=checkpoint_id,
                payload=review.model_dump(mode="json"),
            )
        )
    return review


def finish(session_id: str, checkpoint_id: str) -> DesignSessionRead:
    checkpoint(session_id, checkpoint_id)
    with get_session() as session:
        row = _owned(session, session_id)
        reviewed = session.scalar(
            select(DesignReviewRecord.id)
            .where(DesignReviewRecord.checkpoint_id == checkpoint_id)
            .limit(1)
        )
        if reviewed is None:
            raise ValueError("Review this checkpoint before finishing the session.")
        session.execute(
            update(DesignSession)
            .where(DesignSession.id == row.id, DesignSession.user_id == current_user_id())
            .values(
                status="completed",
                completed_at=func.coalesce(DesignSession.completed_at, datetime.now(UTC)),
            )
        )
        session.refresh(row)
        return _read(row)
