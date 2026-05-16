from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert

from server.db.base import get_session
from server.db.models import Attempt, Event, Problem, State
from server.db.schemas import AttemptRead, EventRead, ProblemRead
from server.db.write_types import ProblemWrite

ACTIVE_ATTEMPT_KEY = "active_attempt_id"


def upsert_problem(problem_data: ProblemWrite) -> None:
    with get_session() as session:
        statement = (
            insert(Problem)
            .values(**problem_data)
            .on_conflict_do_update(
                index_elements=["id"], set_={k: v for k, v in problem_data.items() if k != "id"}
            )
        )
        session.execute(statement)


def get_problem(problem_id: str) -> ProblemRead | None:
    with get_session() as session:
        problem = session.get(Problem, problem_id)
        if problem is None:
            return None
        return ProblemRead.model_validate(problem)


def list_problems(difficulty: str | None = None, tag: str | None = None) -> list[ProblemRead]:
    with get_session() as session:
        statement = select(Problem)
        if difficulty:
            statement = statement.where(Problem.difficulty == difficulty)
        results = list(session.scalars(statement))
        if tag:
            results = [problem for problem in results if tag in problem.tags]
        return [ProblemRead.model_validate(p) for p in results]


def create_attempt(problem_id: str, language: str) -> AttemptRead:
    with get_session() as session:
        attempt = Attempt(
            id=str(uuid4()),
            problem_id=problem_id,
            language=language,
            status="in_progress",
            started_at=datetime.utcnow(),
        )
        session.add(attempt)
        session.flush()

        statement = (
            insert(State)
            .values(key=ACTIVE_ATTEMPT_KEY, value=attempt.id, updated_at=datetime.now(UTC))
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
        if attempt is None:
            return None
        return AttemptRead.model_validate(attempt)


def get_active_attempt() -> AttemptRead | None:
    with get_session() as session:
        row = session.get(State, ACTIVE_ATTEMPT_KEY)
        if row is None or row.value is None:
            return None
        attempt = session.get(Attempt, row.value)
        if attempt is None:
            return None
        return AttemptRead.model_validate(attempt)


def clear_active_attempt() -> None:
    with get_session() as session:
        row = session.get(State, ACTIVE_ATTEMPT_KEY)
        if row is not None:
            row.value = None


def mark_completed(attempt_id: str) -> None:
    with get_session() as session:
        attempt = session.get(Attempt, attempt_id)
        if attempt is not None:
            attempt.status = "completed"
            attempt.completed_at = datetime.now(UTC)
    clear_active_attempt()


def record_event(attempt_id: str, kind: str, payload: dict[str, object] | None = None) -> EventRead:
    with get_session() as session:
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
