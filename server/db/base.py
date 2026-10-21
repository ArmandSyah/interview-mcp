import os
import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

import server.config  # noqa: F401
from server.db.schema_version import SCHEMA_VERSION

DB_DIR = Path(os.environ.get("INTERVIEW_MCP_DB_DIR") or Path.home() / ".interview-mcp")
DB_DIR.mkdir(exist_ok=True, parents=True)
DB_PATH = DB_DIR / "interview_mcp.sqlite"


class Base(DeclarativeBase):
    pass


engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"timeout": 30})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def initialize_database() -> None:
    """Create tables and preserve existing single-user attempts during upgrade."""
    schema_version = SCHEMA_VERSION
    with engine.connect() as connection:
        version = connection.scalar(text("PRAGMA user_version")) or 0
        existing = inspect(connection).get_table_names()
    if version > schema_version:
        raise RuntimeError("This database needs a newer app. Existing data was not changed.")
    database = engine.url.database
    database_path = Path(database) if database and database != ":memory:" else None
    if version < schema_version and existing and database_path is not None:
        # SQLite's backup API includes committed WAL state; a raw file copy does not.
        backup_dir = database_path.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        backup_path = backup_dir / f"interview_mcp.pre-v{schema_version}.{uuid4()}.sqlite"
        with backup_path.open("xb"):
            pass
        backup_path.chmod(0o600)
        with sqlite3.connect(database_path) as source, sqlite3.connect(backup_path) as target:
            source.backup(target)
    with engine.begin() as connection:
        inspector = inspect(connection)
        if "problems" in inspector.get_table_names():
            columns = {column["name"] for column in inspector.get_columns("problems")}
            if "available" not in columns:
                connection.execute(
                    text("ALTER TABLE problems ADD COLUMN available BOOLEAN NOT NULL DEFAULT 1")
                )
        if "attempts" in inspector.get_table_names():
            columns = {column["name"] for column in inspector.get_columns("attempts")}
            if "user_id" not in columns:
                connection.execute(
                    text("ALTER TABLE attempts ADD COLUMN user_id VARCHAR NOT NULL DEFAULT 'local'")
                )
            if "problem_snapshot" not in columns:
                connection.execute(text("ALTER TABLE attempts ADD COLUMN problem_snapshot JSON"))
            if "problem_revision" not in columns:
                connection.execute(text("ALTER TABLE attempts ADD COLUMN problem_revision VARCHAR"))
            if "revision_origin" not in columns:
                connection.execute(
                    text(
                        "ALTER TABLE attempts ADD COLUMN revision_origin VARCHAR NOT NULL "
                        "DEFAULT 'legacy_snapshot'"
                    )
                )
            connection.execute(
                text("CREATE INDEX IF NOT EXISTS ix_attempts_user_id ON attempts (user_id)")
            )
        if "content_pack_versions" in inspector.get_table_names():
            columns = {column["name"] for column in inspector.get_columns("content_pack_versions")}
            for name in ("signed_package", "signed_license"):
                if name not in columns:
                    connection.execute(
                        text(
                            f"ALTER TABLE content_pack_versions ADD COLUMN {name} "
                            "TEXT NOT NULL DEFAULT ''"
                        )
                    )
    Base.metadata.create_all(engine)
    # Snapshot legacy content before startup seeding can replace question rows.
    # This is the content present at migration time, not an invented original revision.
    from sqlalchemy import select

    from server.db.models import Attempt, Problem
    from server.db.revisions import snapshot_problem
    from server.db.schemas import ProblemRead

    with Session(engine) as session:
        for attempt in session.scalars(select(Attempt).where(Attempt.problem_snapshot.is_(None))):
            problem = session.get(Problem, attempt.problem_id)
            if problem is not None:
                snapshot, revision = snapshot_problem(ProblemRead.model_validate(problem))
                attempt.problem_snapshot = snapshot
                attempt.problem_revision = revision
                attempt.revision_origin = "legacy_snapshot"
        session.commit()
    with engine.begin() as connection:
        connection.execute(text(f"PRAGMA user_version = {schema_version}"))
    if database_path is not None:
        database_path.chmod(0o600)


@contextmanager
def get_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
