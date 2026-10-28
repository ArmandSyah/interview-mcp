from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.db import base
from server.db import repo as coding
from server.db.base import Base
from server.design import repo as design
from server.distribution import backup
from server.practice import repo
from tests.test_repo import SAMPLE_PROBLEM

NOW = datetime(2026, 10, 3, 12, tzinfo=UTC)


@pytest.fixture(autouse=True)
def database(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    monkeypatch.setattr(base, "engine", engine)
    monkeypatch.setattr(base, "SessionLocal", sessionmaker(bind=engine, autoflush=False))
    monkeypatch.setattr(repo, "_now", lambda: NOW)
    coding.upsert_problem(SAMPLE_PROBLEM)
    yield
    engine.dispose()


def item(days=0):
    attempt = coding.create_attempt(SAMPLE_PROBLEM["id"], "python")
    return repo.add("coding", attempt.id, days)


def reflect(value, rating="recalled", **changes):
    inputs = {
        "item_id": value.id,
        "reflection_id": str(uuid4()),
        "expected_version": value.version,
        "answer": "My plain-English invariant and a boundary case.",
        "self_rating": rating,
        "takeaway": "I needed one hint.",
        "next_action": "Explain the invariant before coding.",
    }
    inputs.update(changes)
    return repo.reflect(**inputs)


def test_queue_add_is_idempotent_and_retains_pinned_title_after_content_updates():
    value = item(1)
    coding.upsert_problem({**SAMPLE_PROBLEM, "title": "Changed current title"})
    coding.hide_removed_problems([])
    same = repo.add("coding", value.source_id, 30)
    assert same.id == value.id
    assert same.title == SAMPLE_PROBLEM["title"]
    assert same.problem_revision == value.problem_revision
    assert same.due_at == NOW + timedelta(days=1)
    assert len(repo.list_queue()) == 1
    assert "Use a hash map" not in same.model_dump_json()
    assert "Think about complements" not in same.model_dump_json()


def test_sources_and_queue_include_coding_and_design_without_grading_or_completion():
    first = item()
    session = design.start("design-link-aliases")
    second = repo.add("design", session.id, 1)
    assert second.problem_revision == session.brief.revision
    assert {source.kind for source in repo.sources()} == {"coding", "design"}
    assert (
        next(source for source in repo.sources() if source.id == first.source_id).queued_id
        == first.id
    )
    assert {value.source_kind for value in repo.list_queue()} == {"coding", "design"}
    assert design.get(session.id).status == "in_progress"
    assert coding.get_attempt(first.source_id).status == "in_progress"


def test_self_ratings_suggest_bounded_intervals_and_do_not_change_attempt_status():
    value = item()
    for expected in (3, 7, 14, 30, 30):
        saved = reflect(value)
        assert saved.interval_days == expected
        assert saved.next_due_at == NOW + timedelta(days=expected)
        value = repo.list_queue()[0]
    assert value.review_count == 5
    assert reflect(value, "with_effort").interval_days == 3
    value = repo.list_queue()[0]
    assert reflect(value, "needs_work").interval_days == 1
    assert coding.get_attempt(value.source_id).status == "in_progress"


def test_duplicate_reflection_is_idempotent_but_cannot_replace_existing_evidence():
    value = item()
    key = str(uuid4())
    first = reflect(value, reflection_id=key)
    second = reflect(value, reflection_id=key)
    assert first.id == second.id
    assert repo.list_queue()[0].version == 1
    assert len(repo.reflections(value.id)) == 1
    with pytest.raises(ValueError, match="immutable"):
        reflect(value, reflection_id=key, answer="Replacement evidence")


def test_stale_update_rejects_the_entire_reflection_and_preserves_newer_schedule():
    value = item()
    moved = repo.reschedule(value.id, 7, value.version)
    with pytest.raises(ValueError, match="changed"):
        reflect(value)
    assert repo.reflections(value.id) == []
    current = repo.list_queue()[0]
    assert current.due_at == moved.due_at
    assert current.version == moved.version


def test_pausing_keeps_evidence_and_requires_explicit_resume():
    value = item()
    reflect(value)
    value = repo.list_queue()[0]
    paused = repo.pause(value.id, True, value.version)
    assert repo.list_queue(False) == []
    assert len(repo.reflections(value.id)) == 1
    with pytest.raises(ValueError, match="Resume"):
        reflect(paused)
    resumed = repo.pause(value.id, False, paused.version)
    assert resumed.review_count == 1
    assert len(repo.list_queue(False)) == 1


def test_other_users_cannot_read_schedule_reflect_or_export_someone_elses_queue(monkeypatch):
    value = item()
    reflect(value)
    monkeypatch.setattr(repo, "current_user_id", lambda: "other-user")
    monkeypatch.setattr(backup, "current_user_id", lambda: "other-user")
    assert repo.sources() == []
    assert repo.list_queue() == []
    assert backup.export_data()["practice_queue"] == []
    assert backup.export_data()["practice_reflections"] == []
    for action in (
        lambda: repo.add("coding", value.source_id),
        lambda: repo.reflections(value.id),
        lambda: repo.pause(value.id, True, value.version),
        lambda: repo.reschedule(value.id, 7, value.version),
        lambda: reflect(value),
    ):
        with pytest.raises(ValueError, match="not found"):
            action()


def test_owned_export_includes_queue_and_reflections_without_identity_or_credentials():
    value = item()
    saved = reflect(value)
    exported = backup.export_data()
    assert exported["schema_version"] == 4
    assert exported["practice_queue"][0]["id"] == value.id
    assert exported["practice_reflections"][0]["id"] == saved.id
    assert "user_id" not in exported["practice_queue"][0]
    assert "credentials" not in exported


@pytest.mark.parametrize("days", [-1, 366, True])
def test_invalid_delay_does_not_add_an_item(days):
    attempt = coding.create_attempt(SAMPLE_PROBLEM["id"], "python")
    with pytest.raises(ValueError, match="delay"):
        repo.add("coding", attempt.id, days)
    assert repo.list_queue() == []


def test_blank_answer_is_not_counted_as_recall():
    value = item()
    with pytest.raises(ValueError, match="answer"):
        reflect(value, answer="   ")
    assert repo.list_queue()[0].version == 0
