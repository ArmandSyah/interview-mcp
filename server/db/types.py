# server/db/types.py
from __future__ import annotations

from typing import TypedDict

type JSONScalar = str | int | float | bool | None
type JSONValue = JSONScalar | list["JSONValue"] | dict[str, "JSONValue"]
type JSONObject = dict[str, JSONValue]


class ExampleData(TypedDict):
    input: str
    output: str
    explanation: str


class TestCaseData(TypedDict):
    input: list[JSONValue]
    expected: JSONValue


class AlternativeSolutionData(TypedDict):
    name: str
    complexity: str
    description: str


class ProblemData(TypedDict):
    id: str
    title: str
    difficulty: str
    tags: list[str]
    pattern_tags: list[str]
    description_md: str
    examples: list[ExampleData]
    constraints: list[str]
    starter_code: dict[str, str]
    test_cases: dict[str, list[TestCaseData]]
    canonical_solution_md: str
    fallback_hints: list[str]
    common_mistakes: list[str]
    follow_up_questions: list[str]
    alternative_solutions: list[AlternativeSolutionData]
