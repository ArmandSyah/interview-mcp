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
    with engine.connect() as connection:
        assert (
            connection.scalar(text("SELECT user_id FROM attempts WHERE id = 'legacy'")) == "local"
        )
        assert "api_keys" in inspect(connection).get_table_names()
    engine.dispose()
