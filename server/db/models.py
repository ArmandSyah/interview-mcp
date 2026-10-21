# server/db/models.py
from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from server.db.base import Base
from server.db.write_types import (
    ExampleWrite,
    SuboptimalSolutionWrite,
    TestCaseWrite,
)


def utcnow() -> datetime:
    return datetime.now(UTC)


class Problem(Base):
    __tablename__ = "problems"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    difficulty: Mapped[str] = mapped_column(String, nullable=False)
    available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    description_md: Mapped[str] = mapped_column(Text, nullable=False)
    canonical_solution_md: Mapped[str] = mapped_column(Text, nullable=False)

    tags: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    pattern_tags: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    examples: Mapped[list[ExampleWrite]] = mapped_column(JSON, nullable=False, default=list)
    constraints: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    starter_code: Mapped[dict[str, str]] = mapped_column(JSON, nullable=False, default=dict)
    test_cases: Mapped[dict[str, list[TestCaseWrite]]] = mapped_column(
        JSON,
        nullable=False,
        default=dict,
    )
    fallback_hints: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    common_mistakes: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    follow_up_questions: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    suboptimal_solutions: Mapped[list[SuboptimalSolutionWrite]] = mapped_column(
        JSON,
        nullable=False,
        default=list,
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=utcnow,
        onupdate=utcnow,
    )

    attempts: Mapped[list[Attempt]] = relationship(back_populates="problem")

    def __repr__(self) -> str:
        return f"<Problem id={self.id} title={self.title!r}>"


class Attempt(Base):
    __tablename__ = "attempts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[str] = mapped_column(String, nullable=False, default="local", index=True)
    problem_id: Mapped[str] = mapped_column(ForeignKey("problems.id"), nullable=False)
    language: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default="in_progress")
    problem_snapshot: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)
    problem_revision: Mapped[str | None] = mapped_column(String, nullable=True)
    revision_origin: Mapped[str] = mapped_column(String, nullable=False, default="pinned")

    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    problem: Mapped[Problem] = relationship(back_populates="attempts")
    events: Mapped[list[Event]] = relationship(back_populates="attempt")

    def __repr__(self) -> str:
        return f"<Attempt id={self.id} problem_id={self.problem_id} status={self.status!r}>"


class Event(Base):
    __tablename__ = "events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    attempt_id: Mapped[str] = mapped_column(ForeignKey("attempts.id"), nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    attempt: Mapped[Attempt] = relationship(back_populates="events")

    def __repr__(self) -> str:
        return f"<Event id={self.id} kind={self.kind!r}>"


class State(Base):
    __tablename__ = "state"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str | None] = mapped_column(String, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=utcnow,
        onupdate=utcnow,
    )

    def __repr__(self) -> str:
        return f"<State key={self.key!r} value={self.value!r}>"


class ApiKey(Base):
    __tablename__ = "api_keys"

    key_hash: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    revoked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class DesignSession(Base):
    __tablename__ = "design_sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    problem_id: Mapped[str] = mapped_column(String, nullable=False)
    problem_snapshot: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default="in_progress")
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class DesignCheckpoint(Base):
    __tablename__ = "design_checkpoints"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("design_sessions.id"), nullable=False, index=True
    )
    label: Mapped[str] = mapped_column(String, nullable=False)
    scene_digest: Mapped[str] = mapped_column(String, nullable=False)
    notes: Mapped[dict[str, str]] = mapped_column(JSON, nullable=False)
    diagram: Mapped[list[dict[str, object]]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)


class DesignReviewRecord(Base):
    __tablename__ = "design_reviews"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    checkpoint_id: Mapped[str] = mapped_column(
        ForeignKey("design_checkpoints.id"), nullable=False, index=True
    )
    payload: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)


class ContentPackVersion(Base):
    __tablename__ = "content_pack_versions"

    revision: Mapped[str] = mapped_column(String, primary_key=True)
    pack_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    version: Mapped[str] = mapped_column(String, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    manifest: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False)
    license_claims: Mapped[dict[str, object]] = mapped_column(JSON, nullable=False)
    signed_package: Mapped[str] = mapped_column(Text, nullable=False, default="")
    signed_license: Mapped[str] = mapped_column(Text, nullable=False, default="")
    installed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)


class PracticeQueueItem(Base):
    __tablename__ = "practice_queue"
    __table_args__ = (UniqueConstraint("user_id", "source_kind", "source_id"),)

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    source_kind: Mapped[str] = mapped_column(String, nullable=False)
    source_id: Mapped[str] = mapped_column(String, nullable=False)
    problem_id: Mapped[str] = mapped_column(String, nullable=False)
    problem_revision: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    recall_prompts: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    due_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    paused: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    interval_days: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)


class PracticeReflection(Base):
    __tablename__ = "practice_reflections"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    item_id: Mapped[str] = mapped_column(
        ForeignKey("practice_queue.id"), nullable=False, index=True
    )
    answer: Mapped[str] = mapped_column(Text, nullable=False)
    takeaway: Mapped[str] = mapped_column(Text, nullable=False)
    next_action: Mapped[str] = mapped_column(Text, nullable=False)
    self_rating: Mapped[str] = mapped_column(String, nullable=False)
    interval_days: Mapped[int] = mapped_column(Integer, nullable=False)
    next_due_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
