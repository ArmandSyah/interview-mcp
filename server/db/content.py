"""Pure runtime content schemas; importing them does not open a database."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue


class TestCaseContent(BaseModel):
    model_config = ConfigDict(strict=True)
    input: list[JsonValue]
    expected: JsonValue


class ExampleContent(BaseModel):
    input: str
    output: str
    explanation: str = ""


class SuboptimalContent(BaseModel):
    name: str
    complexity: str
    description: str


class ProblemContent(BaseModel):
    """Runtime fields only; authoring and review metadata never enters the database."""

    model_config = ConfigDict(strict=True)
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,60}$")
    title: str = Field(min_length=1)
    difficulty: Literal["easy", "medium", "hard"]
    description_md: str
    canonical_solution_md: str
    tags: list[str]
    pattern_tags: list[str] = Field(default_factory=list)
    examples: list[ExampleContent] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)
    starter_code: dict[str, str]
    test_cases: dict[str, list[TestCaseContent]]
    fallback_hints: list[str]
    common_mistakes: list[str] = Field(default_factory=list)
    follow_up_questions: list[str] = Field(default_factory=list)
    suboptimal_solutions: list[SuboptimalContent] = Field(default_factory=list)
