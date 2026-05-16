from datetime import datetime
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from server.db.base import Base


class Problem(Base):
    __tablename__ = "problems"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    difficulty: Mapped[str] = mapped_column(String, nullable=False)
    description_md: Mapped[str] = mapped_column(Text, nullable=False)
    canonical_solution_md: Mapped[str] = mapped_column(Text, nullable=False)

    tags: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    pattern_tags: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    examples: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    constraints: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    starter_code: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    test_cases: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    fallback_hints: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    common_mistakes: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    follow_up_questions: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    alternative_solutions: Mapped[list] = mapped_column(JSON, nullable=False, default=list)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    attempts: Mapped[list["Attempt"]] = relationship(back_populates="problem")

    def __repr__(self) -> str:
        return f"<Problem id={self.id} title={self.title!r}>"


class Attempt(Base):
    __tablename__ = "attempts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    problem_id: Mapped[str] = mapped_column(ForeignKey("problems.id"), nullable=False)
    language: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default="in_progress")

    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    problem: Mapped["Problem"] = relationship(back_populates="attempts")
    events: Mapped[list["Event"]] = relationship(back_populates="attempt")

    def __repr__(self) -> str:
        return f"<Attempt id={self.id} problem_id={self.problem_id} status={self.status!r}>"


class Event(Base):
    __tablename__ = "events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid4()))
    attempt_id: Mapped[str] = mapped_column(ForeignKey("attempts.id"), nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    attempt: Mapped["Attempt"] = relationship(back_populates="events")

    def __repr__(self) -> str:
        return f"<Event id={self.id} kind={self.kind!r}>"


class State(Base):
    __tablename__ = "state"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str | None] = mapped_column(String, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self) -> str:
        return f"<State key={self.key!r} value={self.value!r}>"