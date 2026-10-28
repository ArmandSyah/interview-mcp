from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from server.db import base
from server.db import repo as coding_repo
from server.db.base import Base
from server.db.models import DesignReviewRecord
from server.design import catalog, repo
from server.design.schemas import DiagramElement
from tests.test_repo import SAMPLE_PROBLEM


@pytest.fixture(autouse=True)
def database(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    monkeypatch.setattr(base, "engine", engine)
    monkeypatch.setattr(base, "SessionLocal", sessionmaker(bind=engine, autoflush=False))
    yield
    engine.dispose()


def make_checkpoint(session_id: str, **changes):
    values = {
        "session_id": session_id,
        "checkpoint_id": str(uuid4()),
        "scene_digest": "a" * 64,
        "notes": {"requirements": "Candidate requirements", "tradeoffs": "A"},
        "diagram": [DiagramElement(id="service", type="rectangle", label="Service")],
        "label": "My first design",
    }
    values.update(changes)
    return repo.save_checkpoint(**values)


def test_original_catalog_is_complete_and_fingerprinted():
    summaries = catalog.summaries()
    assert len(summaries) == 5
    assert len({item.id for item in summaries}) == 5
    for summary in summaries:
        problem = catalog.get_problem(summary.id)
        assert len(problem.hints) == 3
        assert len(problem.rubric) == 6
        assert len(problem.scenarios) == 3
        assert len(problem.revision) == 64
        assert "hints" not in catalog.brief(problem).model_dump()


def test_coding_content_is_pinned_across_updates_and_removal():
    coding_repo.upsert_problem(SAMPLE_PROBLEM)
    old = coding_repo.create_attempt(SAMPLE_PROBLEM["id"], "python")
    coding_repo.upsert_problem(
        {**SAMPLE_PROBLEM, "title": "New title", "fallback_hints": ["New hint"]}
    )
    new = coding_repo.create_attempt(SAMPLE_PROBLEM["id"], "python")
    assert old.problem_revision != new.problem_revision
    assert coding_repo.get_attempt_problem(old.id).title == SAMPLE_PROBLEM["title"]
    assert (
        coding_repo.get_attempt_problem(old.id).fallback_hints == SAMPLE_PROBLEM["fallback_hints"]
    )
    coding_repo.hide_removed_problems([])
    assert coding_repo.get_attempt_problem(old.id) is not None
    assert coding_repo.list_attempts_with_problems()[1].problem_title == SAMPLE_PROBLEM["title"]


def test_design_brief_and_hints_are_pinned(monkeypatch):
    session = repo.start("design-link-aliases")
    changed = catalog.get_problem(session.problem_id)
    changed.title = "Changed title"
    changed.hints[0] = "Changed hint"
    monkeypatch.setitem(catalog.PROBLEMS, session.problem_id, changed)
    assert repo.get(session.id).brief.title == session.brief.title
    assert repo.hint(session.id, 1)["hint"] != "Changed hint"


def test_checkpoints_are_immutable_and_idempotent():
    session = repo.start("design-link-aliases")
    saved = make_checkpoint(session.id)
    same = repo.save_checkpoint(
        session.id,
        saved.id,
        saved.scene_digest,
        saved.notes,
        saved.diagram,
        saved.label,
    )
    assert same.id == saved.id
    assert len(repo.checkpoints(session.id)) == 1
    with pytest.raises(ValueError, match="immutable"):
        repo.save_checkpoint(
            session.id, saved.id, "b" * 64, saved.notes, saved.diagram, saved.label
        )


def test_large_diagram_and_truncated_label_markers_round_trip_without_losing_late_edges():
    session = repo.start("design-link-aliases")
    diagram = [DiagramElement(id=f"node-{index}", type="rectangle") for index in range(2999)]
    diagram[2998].label = "x" * 2000
    diagram[2998].label_truncated = True
    diagram.append(
        DiagramElement(id="late-edge", type="arrow", from_id="node-0", to_id="node-2998")
    )
    saved = make_checkpoint(session.id, diagram=diagram)
    reopened = repo.checkpoint(session.id, saved.id)
    assert len(reopened.diagram) == 3000
    assert reopened.diagram[-1].to_id == "node-2998"
    assert reopened.diagram[2998].label_truncated
    with pytest.raises(ValueError, match="too large"):
        make_checkpoint(session.id, diagram=[*diagram, DiagramElement(id="overflow", type="text")])
    assert len(repo.checkpoints(session.id)) == 1


def test_old_checkpoints_without_label_marker_remain_readable_and_idempotent():
    from server.db.models import DesignCheckpoint

    session = repo.start("design-link-aliases")
    saved = make_checkpoint(session.id)
    with base.get_session() as db:
        row = db.get(DesignCheckpoint, saved.id)
        row.diagram = [
            {key: value for key, value in item.items() if key != "label_truncated"}
            for item in row.diagram
        ]
    loaded = repo.checkpoint(session.id, saved.id)
    assert not loaded.diagram[0].label_truncated
    repeated = repo.save_checkpoint(
        session.id, loaded.id, loaded.scene_digest, loaded.notes, loaded.diagram, loaded.label
    )
    assert repeated.id == saved.id


def test_owned_sessions_cannot_be_read_reviewed_or_changed_by_another_user(monkeypatch):
    session = repo.start("design-link-aliases")
    saved = make_checkpoint(session.id)
    monkeypatch.setattr(repo, "current_user_id", lambda: "another-user")
    for action in [
        lambda: repo.get(session.id),
        lambda: repo.checkpoints(session.id),
        lambda: repo.checkpoint(session.id, saved.id),
        lambda: repo.hint(session.id, 1),
        lambda: make_checkpoint(session.id),
        lambda: repo.evaluate(session.id, saved.id),
        lambda: repo.finish(session.id, saved.id),
    ]:
        with pytest.raises(ValueError, match="not found"):
            action()


def test_checkpoint_cannot_be_read_through_a_different_session():
    first = repo.start("design-link-aliases")
    second = repo.start("design-following-feed")
    saved = make_checkpoint(first.id)
    with pytest.raises(ValueError, match="not found"):
        repo.checkpoint(second.id, saved.id)


def test_review_describes_coverage_not_correctness_and_is_saved():
    session = repo.start("design-link-aliases")
    saved = make_checkpoint(
        session.id,
        notes={
            "requirements": (
                "A candidate explanation with enough detail to invite discussion "
                "of its assumptions and boundaries."
            )
        },
    )
    result = repo.evaluate(session.id, saved.id)
    assert result.source == "curated"
    assert result.checkpoint_id == saved.id
    assert result.scene_digest == saved.scene_digest
    assert result.items[0].status == "discussed"
    assert result.items[1].status == "not_discussed"
    assert "not architectural correctness" in result.limitations
    with base.get_session() as db:
        assert db.scalar(select(DesignReviewRecord)) is not None
    finished = repo.finish(session.id, saved.id)
    assert finished.status == "completed"
    with pytest.raises(ValueError, match="after finishing"):
        make_checkpoint(session.id)


def test_finish_requires_a_review_of_the_selected_checkpoint():
    session = repo.start("design-link-aliases")
    first = make_checkpoint(session.id)
    second = make_checkpoint(session.id)
    repo.evaluate(session.id, first.id)
    with pytest.raises(ValueError, match="Review this checkpoint"):
        repo.finish(session.id, second.id)


def test_concurrent_finish_retries_keep_the_first_completion_time(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'completion.db'}")
    Base.metadata.create_all(engine)
    monkeypatch.setattr(base, "engine", engine)
    monkeypatch.setattr(base, "SessionLocal", sessionmaker(bind=engine, autoflush=False))
    try:
        session = repo.start("design-link-aliases")
        saved = make_checkpoint(session.id)
        repo.evaluate(session.id, saved.id)
        ready = Barrier(2)

        def finish():
            ready.wait(timeout=5)
            return repo.finish(session.id, saved.id)

        with ThreadPoolExecutor(max_workers=2) as pool:
            first, second = [
                future.result(timeout=10) for future in [pool.submit(finish), pool.submit(finish)]
            ]
        assert first.completed_at is not None
        assert second == first, (
            f"Concurrent finish({session.id}, {saved.id}) changed completion: {first} -> {second}"
        )
        assert repo.get(session.id) == first
        assert repo.finish(session.id, saved.id) == first
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "changes",
    [
        {"scene_digest": "invalid"},
        {"notes": {"secret": "no"}},
        {"notes": {"requirements": "x" * 5001}},
        {"label": ""},
        {"checkpoint_id": "../escape"},
    ],
)
def test_bad_checkpoint_payloads_are_rejected(changes):
    session = repo.start("design-link-aliases")
    with pytest.raises(ValueError):
        make_checkpoint(session.id, **changes)
