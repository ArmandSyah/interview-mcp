# server/db/write_types.py
"""
Write-side type contracts.

These TypedDicts define the shape of data flowing INTO the database.
Use them when creating or updating records (e.g., upsert_problem).

Naming convention: *Write suffix signals "this is input data".
"""

from __future__ import annotations

from typing import TypedDict

type JSONScalar = str | int | float | bool | None
type JSONValue = JSONScalar | list["JSONValue"] | dict[str, "JSONValue"]
type JSONObject = dict[str, JSONValue]


class ExampleWrite(TypedDict):
    input: str
    output: str
    explanation: str


class TestCaseWrite(TypedDict):
    input: list[JSONValue]
    expected: JSONValue


class SuboptimalSolutionWrite(TypedDict):
    name: str
    complexity: str
    description: str


class ProblemWrite(TypedDict):
    id: str
    title: str
    difficulty: str
    tags: list[str]
    pattern_tags: list[str]
    description_md: str
    examples: list[ExampleWrite]
    constraints: list[str]
    starter_code: dict[str, str]
    test_cases: dict[str, list[TestCaseWrite]]
    canonical_solution_md: str
    fallback_hints: list[str]
    common_mistakes: list[str]
    follow_up_questions: list[str]
    suboptimal_solutions: list[SuboptimalSolutionWrite]
