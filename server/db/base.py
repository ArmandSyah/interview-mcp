from pathlib import Path
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session, DeclarativeBase

DB_DIR = Path.home() / ".interview-mcp"
DB_DIR.mkdir(exist_ok=True, parents=True)
DB_PATH = DB_DIR / "interview_mcp.sqlite"

class Base(DeclarativeBase):
    pass

engine = create_engine(f"sqlite:///{DB_PATH}")
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

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