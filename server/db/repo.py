from server.db.models import Attempt, Event, Problem


def upsert_problem(problem_data: dict[str, object]) -> None:
    raise NotImplementedError


def get_problem(problem_id: str) -> Problem | None:
    raise NotImplementedError


def list_problems(difficulty: str | None = None, tag: str | None = None) -> list[Problem]:
    raise NotImplementedError


def create_attempt(problem_id: str, language: str) -> Attempt:
    raise NotImplementedError


def get_attempt(attempt_id: str) -> Attempt | None:
    raise NotImplementedError


def get_active_attempt() -> Attempt | None:
    raise NotImplementedError


def set_active_attempt(attempt_id: str) -> None:
    raise NotImplementedError


def clear_active_attempt() -> None:
    raise NotImplementedError


def mark_completed(attempt_id: str) -> None:
    raise NotImplementedError


def record_event(attempt_id: str, kind: str, payload: dict[str, object] | None = None) -> Event:
    raise NotImplementedError
