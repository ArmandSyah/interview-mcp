from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

NoteKey = Literal["requirements", "api", "data", "capacity", "tradeoffs", "failure_modes"]
MAX_DIAGRAM_ELEMENTS = 3000
MAX_DIAGRAM_SUMMARY_BYTES = 700_000


class Criterion(BaseModel):
    key: NoteKey
    title: str
    prompt: str


class DesignBrief(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,60}$")
    title: str
    difficulty: Literal["easy", "medium", "hard"]
    tags: list[str]
    brief_md: str
    requirements: list[str]
    constraints: list[str]
    scenarios: list[str]
    rubric: list[Criterion]
    time_budget_minutes: int = 40
    revision: str = ""
    pack_id: str = "starter-system-design"


class DesignProblem(DesignBrief):
    hints: list[str] = Field(min_length=3, max_length=3)


class DesignSummary(BaseModel):
    id: str
    title: str
    difficulty: str
    tags: list[str]
    revision: str
    time_budget_minutes: int
    pack_id: str


class DiagramElement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=128)
    type: str = Field(min_length=1, max_length=30)
    label: str = Field(default="", max_length=2000)
    label_truncated: bool = False
    kind: str = Field(default="", max_length=60)
    from_id: str | None = Field(default=None, max_length=128)
    to_id: str | None = Field(default=None, max_length=128)


class DesignSessionRead(BaseModel):
    id: str
    problem_id: str
    brief: DesignBrief
    status: Literal["in_progress", "completed"]
    started_at: datetime
    completed_at: datetime | None


class DesignCheckpointRead(BaseModel):
    id: str
    session_id: str
    label: str
    scene_digest: str
    notes: dict[NoteKey, str]
    diagram: list[DiagramElement]
    created_at: datetime


class ReviewItem(BaseModel):
    key: NoteKey
    title: str
    status: Literal["not_discussed", "needs_explanation", "discussed"]
    evidence: str
    question: str


class DesignReview(BaseModel):
    checkpoint_id: str
    scene_digest: str
    rubric_version: str
    source: Literal["curated"] = "curated"
    items: list[ReviewItem]
    summary: str
    limitations: str
