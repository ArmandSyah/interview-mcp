import datetime
from uuid import uuid4

from sqlalchemy import insert, select

from server.db.base import get_session
from server.db.models import Attempt, Event, Problem, State
from server.db.types import ProblemData

ACTIVE_ATTEMPT_KEY = "active_attempt_id"


def upsert_problem(problem_data: ProblemData) -> None:
    with get_session() as session:
        statement = (
            insert(Problem)
            .values(**problem_data)
            .on_conflict_do_update(
                index_elements=["id"], set_={k: v for k, v in problem_data.items() if k != "id"}
            )
        )
        session.execute(statement)


def get_problem(problem_id: str) -> Problem | None:
    with get_session() as session:
        return session.get(Problem, problem_id)


def list_problems(difficulty: str | None = None, tag: str | None = None) -> list[Problem]:
    with get_session() as session:
        statement = select(Problem)
        if difficulty:
            statement = statement.where(Problem.difficulty == difficulty)
        results = list(session.scalars(statement))
        if tag:
            results = [problem for problem in results if tag in problem.tags]
        return results


def create_attempt(problem_id: str, language: str) -> Attempt:
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
        set_active_attempt(attempt_id=attempt.id)
        return attempt


def get_attempt(attempt_id: str) -> Attempt | None:
    with get_session() as session:
        return session.get(Attempt, attempt_id)


def get_active_attempt() -> Attempt | None:
    with get_session() as session:
        row = session.get(State, ACTIVE_ATTEMPT_KEY)
        if row is None or row.value is None:
            return None
        return session.get(Attempt, row.value)


def set_active_attempt(attempt_id: str) -> None:
    with get_session() as session:
        statement = (
            insert(State)
            .values(key=ACTIVE_ATTEMPT_KEY, value=attempt_id, updated_at=datetime.utcnow())
            .on_conflict_do_update(
                index_elements=["key"], set_={"updated_at": datetime.utcnow(), "value": attempt_id}
            )
        )
        session.execute(statement)


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
            attempt.completed_at = datetime.utcnow()
    clear_active_attempt()


def record_event(attempt_id: str, kind: str, payload: dict[str, object] | None = None) -> Event:
    with get_session() as session:
        event = Event(
            id=str(uuid4()),
            attempt_id=attempt_id,
            kind=kind,
            payload=payload,
            created_at=datetime.utcnow(),
        )
        session.add(event)
        return event
