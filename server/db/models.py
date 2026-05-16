from server.db.base import Base


class Problem(Base):
    __tablename__ = "problems"


class Attempt(Base):
    __tablename__ = "attempts"


class Event(Base):
    __tablename__ = "events"


class State(Base):
    __tablename__ = "state"
