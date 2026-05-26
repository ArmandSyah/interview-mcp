"""
Public result shapes for code test runs.

These models are separate from Piston's ExecutionResult on purpose: Piston is
an implementation detail, while these objects are the MCP tool contract.
"""

from __future__ import annotations

from pydantic import BaseModel


class TestCaseResult(BaseModel):
    """Outcome of a single problem test case."""

    index: int
    passed: bool
    input: list[object]
    expected: object
    actual: object | None = None
    user_stdout: str = ""
    user_stderr: str = ""
    error: str | None = None
    wall_time_ms: int = 0


class TestRunResult(BaseModel):
    """Outcome of running all tests for one attempt."""

    attempt_id: str
    problem_id: str
    tests_total: int
    tests_passed: int
    tests: list[TestCaseResult]
    all_passed: bool


class SubmissionResult(BaseModel):
    """Outcome of a submit_solution call."""

    completed: bool
    test_run: TestRunResult
    followup_questions: str | None = None
    message: str
