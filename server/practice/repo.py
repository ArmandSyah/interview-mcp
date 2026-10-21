"""Candidate-controlled recall scheduling; self-ratings are not correctness grades."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import cast
from uuid import UUID, uuid4

from sqlalchemy import func, select, update
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from server.core.identity import current_user_id
from server.db.base import get_session
from server.db.models import Attempt, DesignSession, PracticeQueueItem, PracticeReflection
from server.db.schemas import ProblemRead
from server.design.schemas import DesignProblem
from server.practice.schemas import (
    PracticeKind,
    PracticeQueueRead,
    PracticeReflectionRead,
    PracticeSourceRead,
    SelfRating,
)

INTERVALS = (1, 3, 7, 14, 30)
PROMPTS = {
    "coding": [
        "Without opening your solution, explain the contract and the invariant "
        "behind your approach.",
        "Explain the time/space costs and one boundary case that could break your first attempt.",
        "What did you need help with, and what will you reason through independently next time?",
    ],
    "design": [
        "Without opening your diagram, state the most important requirement and assumption.",
        "Explain one decision and an alternative you rejected. What would change your choice?",
        "Trace a request through your design and explain one failure mode and recovery guarantee.",
    ],
}


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _now() -> datetime:
    return datetime.now(UTC)


def _days(value: int) -> int:
    if type(value) is not int or not 0 <= value <= 365:
        raise ValueError("Choose a delay between 0 and 365 days.")
    return value


def _source(session: Session, kind: PracticeKind, source_id: str) -> PracticeSourceRead:
    if kind == "coding":
        attempt = session.get(Attempt, source_id)
        if attempt is None or attempt.user_id != current_user_id():
            raise ValueError("Practice source not found.")
        if not attempt.problem_snapshot or not attempt.problem_revision:
            raise ValueError("This legacy attempt has no recoverable pinned problem.")
        problem = ProblemRead.model_validate(attempt.problem_snapshot)
        revision = attempt.problem_revision
        row: Attempt | DesignSession = attempt
        title = problem.title
    elif kind == "design":
        design = session.get(DesignSession, source_id)
        if design is None or design.user_id != current_user_id():
            raise ValueError("Practice source not found.")
        brief = DesignProblem.model_validate(design.problem_snapshot)
        revision, title, row = brief.revision, brief.title, design
    else:
        raise ValueError("Choose coding or design practice.")
    return PracticeSourceRead(
        id=row.id,
        kind=kind,
        problem_id=row.problem_id,
        problem_revision=revision,
        title=title,
        status=row.status,
        started_at=_utc(row.started_at),
        queued_id=None,
    )


def sources(limit: int = 100) -> list[PracticeSourceRead]:
    if not 1 <= limit <= 500:
        raise ValueError("Source limit must be between 1 and 500.")
    with get_session() as session:
        results: list[PracticeSourceRead] = []
        for model, kind in ((Attempt, "coding"), (DesignSession, "design")):
            rows = cast(
                "list[Attempt | DesignSession]",
                list(
                    session.scalars(
                        select(model)
                        .where(model.user_id == current_user_id())
                        .order_by(model.started_at.desc())
                        .limit(limit)
                    )
                ),
            )
            for row in rows:
                if isinstance(row, Attempt) and (
                    not row.problem_snapshot or not row.problem_revision
                ):
                    continue
                results.append(_source(session, cast(PracticeKind, kind), row.id))
        queued = {
            (row.source_kind, row.source_id): row.id
            for row in session.scalars(
                select(PracticeQueueItem).where(PracticeQueueItem.user_id == current_user_id())
            )
        }
        for result in results:
            result.queued_id = queued.get((result.kind, result.id))
        return sorted(results, key=lambda value: value.started_at, reverse=True)[:limit]


def _owned(session: Session, item_id: str) -> PracticeQueueItem:
    row = session.get(PracticeQueueItem, item_id)
    if row is None or row.user_id != current_user_id():
        raise ValueError("Practice queue item not found.")
    return row


def _read(
    session: Session, row: PracticeQueueItem, review_count: int | None = None
) -> PracticeQueueRead:
    count = (
        review_count
        if review_count is not None
        else (
            session.scalar(
                select(func.count())
                .select_from(PracticeReflection)
                .where(PracticeReflection.item_id == row.id)
            )
            or 0
        )
    )
    return PracticeQueueRead(
        id=row.id,
        source_kind=cast(PracticeKind, row.source_kind),
        source_id=row.source_id,
        problem_id=row.problem_id,
        problem_revision=row.problem_revision,
        title=row.title,
        recall_prompts=row.recall_prompts,
        due_at=_utc(row.due_at),
        paused=row.paused,
        interval_days=row.interval_days,
        version=row.version,
        last_reviewed_at=_utc(row.last_reviewed_at) if row.last_reviewed_at else None,
        review_count=count,
    )


def list_queue(include_paused: bool = True, limit: int = 500) -> list[PracticeQueueRead]:
    if not 1 <= limit <= 2000:
        raise ValueError("Queue limit must be between 1 and 2000.")
    with get_session() as session:
        query = select(PracticeQueueItem).where(PracticeQueueItem.user_id == current_user_id())
        if not include_paused:
            query = query.where(PracticeQueueItem.paused.is_(False))
        rows = list(
            session.scalars(
                query.order_by(
                    PracticeQueueItem.paused, PracticeQueueItem.due_at, PracticeQueueItem.id
                ).limit(limit)
            )
        )
        counts: dict[str, int] = {
            key: count
            for key, count in session.execute(
                select(PracticeReflection.item_id, func.count())
                .where(PracticeReflection.item_id.in_([row.id for row in rows]))
                .group_by(PracticeReflection.item_id)
            ).all()
        }
        return [_read(session, row, counts.get(row.id, 0)) for row in rows]


def get(item_id: str) -> PracticeQueueRead:
    with get_session() as session:
        return _read(session, _owned(session, item_id))


def add(kind: PracticeKind, source_id: str, days_ahead: int = 1) -> PracticeQueueRead:
    _days(days_ahead)
    with get_session() as session:
        source = _source(session, kind, source_id)
        session.execute(
            insert(PracticeQueueItem)
            .values(
                id=str(uuid4()),
                user_id=current_user_id(),
                source_kind=kind,
                source_id=source.id,
                problem_id=source.problem_id,
                problem_revision=source.problem_revision,
                title=source.title,
                recall_prompts=PROMPTS[kind],
                due_at=_now() + timedelta(days=days_ahead),
                paused=False,
                interval_days=1,
                version=0,
            )
            .on_conflict_do_nothing(index_elements=["user_id", "source_kind", "source_id"])
        )
        row = session.scalar(
            select(PracticeQueueItem).where(
                PracticeQueueItem.user_id == current_user_id(),
                PracticeQueueItem.source_kind == kind,
                PracticeQueueItem.source_id == source_id,
            )
        )
        assert row is not None
        return _read(session, row)


def _change(
    session: Session, row: PracticeQueueItem, expected_version: int, values: dict[str, object]
) -> None:
    if type(expected_version) is not int or expected_version < 0:
        raise ValueError("Invalid queue version.")
    result = session.execute(
        update(PracticeQueueItem)
        .where(
            PracticeQueueItem.id == row.id,
            PracticeQueueItem.user_id == current_user_id(),
            PracticeQueueItem.version == expected_version,
        )
        .values(**values, version=expected_version + 1)
    )
    if result.rowcount != 1:  # type: ignore[attr-defined]
        raise ValueError(
            "This queue item changed. Refresh before saving your reflection or schedule."
        )
    session.refresh(row)


def reschedule(item_id: str, days_ahead: int, expected_version: int) -> PracticeQueueRead:
    _days(days_ahead)
    with get_session() as session:
        row = _owned(session, item_id)
        _change(session, row, expected_version, {"due_at": _now() + timedelta(days=days_ahead)})
        return _read(session, row)


def pause(item_id: str, paused: bool, expected_version: int) -> PracticeQueueRead:
    if type(paused) is not bool:
        raise ValueError("Use a boolean pause setting.")
    with get_session() as session:
        row = _owned(session, item_id)
        _change(session, row, expected_version, {"paused": paused})
        return _read(session, row)


def _reflection(row: PracticeReflection) -> PracticeReflectionRead:
    return PracticeReflectionRead(
        id=row.id,
        item_id=row.item_id,
        answer=row.answer,
        takeaway=row.takeaway,
        next_action=row.next_action,
        self_rating=cast(SelfRating, row.self_rating),
        interval_days=row.interval_days,
        next_due_at=_utc(row.next_due_at),
        created_at=_utc(row.created_at),
    )


def reflections(item_id: str, limit: int = 50) -> list[PracticeReflectionRead]:
    if not 1 <= limit <= 500:
        raise ValueError("Reflection limit must be between 1 and 500.")
    with get_session() as session:
        _owned(session, item_id)
        rows = session.scalars(
            select(PracticeReflection)
            .where(PracticeReflection.item_id == item_id)
            .order_by(PracticeReflection.created_at.desc())
            .limit(limit)
        )
        return [_reflection(row) for row in rows]


def reflect(
    item_id: str,
    reflection_id: str,
    expected_version: int,
    answer: str,
    self_rating: SelfRating,
    takeaway: str = "",
    next_action: str = "",
) -> PracticeReflectionRead:
    UUID(reflection_id)
    if not answer.strip() or len(answer) > 8000 or len(takeaway) > 2000 or len(next_action) > 2000:
        raise ValueError(
            "Record an answer (up to 8000 characters); takeaway/next action are at most 2000 each."
        )
    if self_rating not in {"needs_work", "with_effort", "recalled"}:
        raise ValueError("Choose your own recall rating.")
    evidence = {
        "answer": answer.strip(),
        "takeaway": takeaway.strip(),
        "next_action": next_action.strip(),
        "self_rating": self_rating,
    }
    with get_session() as session:
        item = _owned(session, item_id)
        existing = session.get(PracticeReflection, reflection_id)
        if existing is not None:
            if existing.item_id != item_id or any(
                getattr(existing, key) != value for key, value in evidence.items()
            ):
                raise ValueError("A reflection is immutable. Record a new reflection instead.")
            return _reflection(existing)
        if item.paused:
            raise ValueError("Resume this queue item before recording a recall.")
        interval = (
            1
            if self_rating == "needs_work"
            else min(3, item.interval_days)
            if self_rating == "with_effort"
            else next((value for value in INTERVALS if value > item.interval_days), 30)
        )
        now = _now()
        due = now + timedelta(days=interval)
        _change(
            session,
            item,
            expected_version,
            {"due_at": due, "last_reviewed_at": now, "interval_days": interval},
        )
        row = PracticeReflection(
            id=reflection_id,
            item_id=item_id,
            **evidence,
            interval_days=interval,
            next_due_at=due,
            created_at=now,
        )
        session.add(row)
        session.flush()
        return _reflection(row)
