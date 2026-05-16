# server/db/schemas.py
"""
Read-side schema contracts.

These Pydantic models define the shape of data flowing OUT of the database.
Repo functions return these models to consumers (MCP tools, API handlers).

Naming convention: *Read suffix signals "this is output data".

Usage:
    problem = repo.get_problem("0001")   # returns ProblemRead
    attempt = repo.create_attempt(...)   # returns AttemptRead
    event = repo.record_event(...)       # returns EventRead
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class ExampleRead(BaseModel):
    input: str
    output: str
    explanation: str


class SuboptimalSolutionRead(BaseModel):
    name: str
    complexity: str
    description: str


class ProblemCatalogRead(BaseModel):
    difficulties: list[str]
    tags: list[str]
    pattern_tags: list[str]


class ProblemSummaryRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    title: str
    difficulty: str
    tags: list[str]
    pattern_tags: list[str]


class ProblemRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    title: str
    difficulty: str
    tags: list[str]
    pattern_tags: list[str]
    description_md: str
    examples: list[ExampleRead]
    constraints: list[str]
    starter_code: dict[str, str]
    test_cases: dict[str, list[dict[str, object]]]
    canonical_solution_md: str
    fallback_hints: list[str]
    common_mistakes: list[str]
    follow_up_questions: list[str]
    suboptimal_solutions: list[SuboptimalSolutionRead]
    created_at: datetime
    updated_at: datetime


class AttemptRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    problem_id: str
    language: str
    status: str
    started_at: datetime
    completed_at: datetime | None


class EventRead(BaseModel):
    model_config = {"from_attributes": True}

    id: str
    attempt_id: str
    kind: str
    payload: dict[str, object] | None
    created_at: datetime


class StateRead(BaseModel):
    model_config = {"from_attributes": True}

    key: str
    value: str | None
    updated_at: datetime
