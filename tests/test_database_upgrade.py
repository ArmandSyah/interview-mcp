"""Upgrade a populated pre-auth database without sharing legacy attempts."""

from sqlalchemy import create_engine, inspect, text

from server.db import base


def test_upgrade_preserves_legacy_attempts_as_local(monkeypatch, tmp_path) -> None:
    engine = create_engine(f"sqlite:///{tmp_path / 'legacy.sqlite'}")
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE attempts (id VARCHAR PRIMARY KEY, problem_id VARCHAR NOT NULL, "
                "language VARCHAR NOT NULL, status VARCHAR NOT NULL, started_at DATETIME, "
                "completed_at DATETIME)"
            )
        )
        connection.execute(
            text(
                "INSERT INTO attempts (id, problem_id, language, status) "
                "VALUES ('legacy', 'problem', 'python', 'in_progress')"
            )
        )
    monkeypatch.setattr(base, "engine", engine)
    base.initialize_database()
    base.initialize_database()
    backups = list((tmp_path / "backups").glob("*.sqlite"))
    assert len(backups) == 1
    saved = create_engine(f"sqlite:///{backups[0]}")
    with saved.connect() as connection:
        assert connection.scalar(text("SELECT id FROM attempts")) == "legacy"
        assert "user_id" not in {
            column["name"] for column in inspect(connection).get_columns("attempts")
        }
    saved.dispose()
    with engine.connect() as connection:
        assert (
            connection.scalar(text("SELECT user_id FROM attempts WHERE id = 'legacy'")) == "local"
        )
        assert "api_keys" in inspect(connection).get_table_names()
        assert connection.scalar(text("PRAGMA user_version")) == 4
    engine.dispose()


def test_newer_schema_is_not_downgraded(monkeypatch, tmp_path) -> None:
    import pytest

    engine = create_engine(f"sqlite:///{tmp_path / 'future.sqlite'}")
    with engine.begin() as connection:
        connection.execute(text("PRAGMA user_version = 99"))
    monkeypatch.setattr(base, "engine", engine)
    with pytest.raises(RuntimeError, match="newer app"):
        base.initialize_database()
    with engine.connect() as connection:
        assert connection.scalar(text("PRAGMA user_version")) == 99
    engine.dispose()


def test_version_three_adds_queue_after_preserving_a_database_backup(monkeypatch, tmp_path) -> None:
    from server.db.base import Base
    from server.db.models import State

    engine = create_engine(f"sqlite:///{tmp_path / 'v3.sqlite'}")
    old_tables = [
        table
        for table in Base.metadata.sorted_tables
        if table.name not in {"practice_queue", "practice_reflections"}
    ]
    Base.metadata.create_all(engine, tables=old_tables)
    with engine.begin() as connection:
        connection.execute(text("PRAGMA user_version = 3"))
        connection.execute(State.__table__.insert().values(key="practice-marker", value="kept"))
    monkeypatch.setattr(base, "engine", engine)
    base.initialize_database()
    base.initialize_database()
    backups = list((tmp_path / "backups").glob("interview_mcp.pre-v4.*.sqlite"))
    assert len(backups) == 1
    saved = create_engine(f"sqlite:///{backups[0]}")
    with saved.connect() as connection:
        assert connection.scalar(text("PRAGMA user_version")) == 3
        assert "practice_queue" not in inspect(connection).get_table_names()
        assert (
            connection.scalar(text("SELECT value FROM state WHERE key = 'practice-marker'"))
            == "kept"
        )
    with engine.connect() as connection:
        assert connection.scalar(text("PRAGMA user_version")) == 4
        assert {"practice_queue", "practice_reflections"} <= set(
            inspect(connection).get_table_names()
        )
        assert (
            connection.scalar(text("SELECT value FROM state WHERE key = 'practice-marker'"))
            == "kept"
        )
    saved.dispose()
    engine.dispose()
