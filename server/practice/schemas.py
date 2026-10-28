from datetime import datetime
from typing import Literal

from pydantic import BaseModel

PracticeKind = Literal["coding", "design"]
SelfRating = Literal["needs_work", "with_effort", "recalled"]


class PracticeSourceRead(BaseModel):
    id: str
    kind: PracticeKind
    problem_id: str
    problem_revision: str
    title: str
    status: str
    started_at: datetime
    queued_id: str | None


class PracticeQueueRead(BaseModel):
    id: str
    source_kind: PracticeKind
    source_id: str
    problem_id: str
    problem_revision: str
    title: str
    recall_prompts: list[str]
    due_at: datetime
    paused: bool
    interval_days: int
    version: int
    last_reviewed_at: datetime | None
    review_count: int


class PracticeReflectionRead(BaseModel):
    id: str
    item_id: str
    answer: str
    takeaway: str
    next_action: str
    self_rating: SelfRating
    interval_days: int
    next_due_at: datetime
    created_at: datetime
