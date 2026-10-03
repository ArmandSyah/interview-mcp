import os
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

import server.config  # noqa: F401

DB_DIR = Path(os.environ.get("INTERVIEW_MCP_DB_DIR") or Path.home() / ".interview-mcp")
DB_DIR.mkdir(exist_ok=True, parents=True)
DB_PATH = DB_DIR / "interview_mcp.sqlite"


class Base(DeclarativeBase):
    pass


engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"timeout": 30})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def initialize_database() -> None:
    """Create tables and preserve existing single-user attempts during upgrade."""
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
            connection.execute(
                text("CREATE INDEX IF NOT EXISTS ix_attempts_user_id ON attempts (user_id)")
            )
    Base.metadata.create_all(engine)


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
