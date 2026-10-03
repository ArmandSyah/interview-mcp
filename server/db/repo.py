from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import joinedload

from server.core.identity import current_user_id
from server.db.base import get_session
from server.db.models import Attempt, Event, Problem, State
from server.db.schemas import AttemptRead, EventRead, ProblemRead
from server.db.write_types import ProblemWrite

ACTIVE_ATTEMPT_KEY = "active_attempt_id"


def _active_attempt_key() -> str:
    user_id = current_user_id()
    return ACTIVE_ATTEMPT_KEY if user_id == "local" else f"active_attempt_id:{user_id}"


class AttemptWithProblem(BaseModel):
    """An attempt joined with display fields from its problem."""

    attempt: AttemptRead
    problem_title: str
    problem_difficulty: str


def upsert_problem(problem_data: ProblemWrite) -> None:
    with get_session() as session:
        statement = (
            insert(Problem)
            .values(**problem_data, available=True)
            .on_conflict_do_update(
                index_elements=["id"],
                set_={**{k: v for k, v in problem_data.items() if k != "id"}, "available": True},
            )
        )
        session.execute(statement)


def get_problem(problem_id: str, *, available_only: bool = False) -> ProblemRead | None:
    with get_session() as session:
        problem = session.get(Problem, problem_id)
        if problem is None or (available_only and not problem.available):
            return None
        return ProblemRead.model_validate(problem)


def list_problems(difficulty: str | None = None, tag: str | None = None) -> list[ProblemRead]:
    with get_session() as session:
        statement = select(Problem).where(Problem.available.is_(True))
        if difficulty:
            statement = statement.where(Problem.difficulty == difficulty)
        results = list(session.scalars(statement))
        if tag:
            results = [problem for problem in results if tag in problem.tags]
        return [ProblemRead.model_validate(p) for p in results]


def hide_removed_problems(available_ids: list[str]) -> None:
    """Retain historical attempts but stop offering questions removed from the corpus."""
    with get_session() as session:
        session.execute(
            update(Problem).where(Problem.id.not_in(available_ids)).values(available=False)
        )


def list_attempts_with_problems(limit: int = 50) -> list[AttemptWithProblem]:
    if not 1 <= limit <= 500:
        raise ValueError("limit must be between 1 and 500")

    with get_session() as session:
        statement = (
            select(Attempt)
            .where(Attempt.user_id == current_user_id())
            .options(joinedload(Attempt.problem))
            .order_by(Attempt.started_at.desc())
            .limit(limit)
        )
        attempts = list(session.scalars(statement))
        return [
            AttemptWithProblem(
                attempt=AttemptRead.model_validate(attempt),
                problem_title=attempt.problem.title,
                problem_difficulty=attempt.problem.difficulty,
            )
            for attempt in attempts
        ]


def create_attempt(problem_id: str, language: str) -> AttemptRead:
    with get_session() as session:
        attempt = Attempt(
            id=str(uuid4()),
            user_id=current_user_id(),
            problem_id=problem_id,
            language=language,
            status="in_progress",
            started_at=datetime.now(UTC),
        )
        session.add(attempt)
        session.flush()

        statement = (
            insert(State)
            .values(key=_active_attempt_key(), value=attempt.id, updated_at=datetime.now(UTC))
            .on_conflict_do_update(
                index_elements=["key"],
                set_={"value": attempt.id, "updated_at": datetime.now(UTC)},
            )
        )
        session.execute(statement)

        return AttemptRead.model_validate(attempt)


def get_attempt(attempt_id: str) -> AttemptRead | None:
    with get_session() as session:
        attempt = session.get(Attempt, attempt_id)
        if attempt is None or attempt.user_id != current_user_id():
            return None
        return AttemptRead.model_validate(attempt)


def get_active_attempt() -> AttemptRead | None:
    with get_session() as session:
        row = session.get(State, _active_attempt_key())
        if row is None or row.value is None:
            return None
        attempt = session.get(Attempt, row.value)
        if attempt is None or attempt.user_id != current_user_id():
            return None
        return AttemptRead.model_validate(attempt)


def clear_active_attempt() -> None:
    with get_session() as session:
        row = session.get(State, _active_attempt_key())
        if row is not None:
            row.value = None


def mark_completed(attempt_id: str) -> None:
    with get_session() as session:
        attempt = session.get(Attempt, attempt_id)
        if attempt is not None and attempt.user_id == current_user_id():
            attempt.status = "completed"
            attempt.completed_at = datetime.now(UTC)
            row = session.get(State, _active_attempt_key())
            if row is not None and row.value == attempt.id:
                row.value = None


def record_event(attempt_id: str, kind: str, payload: dict[str, object] | None = None) -> EventRead:
    with get_session() as session:
        attempt = session.get(Attempt, attempt_id)
        if attempt is None or attempt.user_id != current_user_id():
            raise ValueError(f"Attempt {attempt_id!r} not found.")
        event = Event(
            id=str(uuid4()),
            attempt_id=attempt_id,
            kind=kind,
            payload=payload,
            created_at=datetime.now(UTC),
        )
        session.add(event)
        session.flush()
        return EventRead.model_validate(event)
