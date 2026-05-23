"""
Unit tests for HintEngine.

These tests use a MockProvider — zero network calls, fully deterministic.
Real-LLM tests live in tests/test_golden.py and are gated behind RUN_GOLDEN_TESTS.
"""

from __future__ import annotations

from datetime import datetime

from server.db.schemas import AttemptRead, ExampleRead, ProblemRead
from server.hints.engine import HintEngine, _response_has_long_code_block


class MockProvider:
    """Satisfies LLMProvider structurally. Returns canned responses in order."""

    def __init__(self, responses: list[str]) -> None:
        self._responses = iter(responses)
        self.calls: list[dict[str, object]] = []

    def generate(self, system: str, user: str, max_tokens: int = 400) -> str:
        self.calls.append({"system": system, "user": user, "max_tokens": max_tokens})
        return next(self._responses)


def make_problem(**overrides: object) -> ProblemRead:
    defaults: dict[str, object] = {
        "id": "0001",
        "title": "Pair Budget Match",
        "difficulty": "easy",
        "tags": ["array"],
        "pattern_tags": ["hash-map"],
        "description_md": "Find two prices that add up to budget.",
        "examples": [ExampleRead(input="[4,9,1,8], 10", output="[1,2]", explanation="9+1=10")],
        "constraints": ["2 <= prices.length <= 10^4"],
        "starter_code": {"python": "def solution(): pass"},
        "test_cases": {},
        "canonical_solution_md": "Use a hash map.",
        "fallback_hints": [
            "Think about lookups.",
            "Use a hash map.",
            "Iterate once, store complements.",
        ],
        "common_mistakes": [],
        "follow_up_questions": [],
        "suboptimal_solutions": [],
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
    }
    defaults.update(overrides)
    return ProblemRead.model_validate(defaults)


def make_attempt() -> AttemptRead:
    return AttemptRead.model_validate(
        {
            "id": "attempt-1",
            "problem_id": "0001",
            "language": "python",
            "status": "in_progress",
            "started_at": datetime.utcnow(),
            "completed_at": None,
        }
    )


# --- Core engine behavior -----------------------------------------------------


def test_clean_response_returned_directly() -> None:
    """No filter trigger → one provider call, no fallback."""
    provider = MockProvider(["Think about what you'd want to look up quickly."])
    engine = HintEngine(provider)
    hint, meta = engine.generate_hint(
        make_attempt(), make_problem(), "def solution(): pass", depth=1
    )
    assert "look up" in hint
    assert meta["used_fallback"] is False
    assert meta["fallback_reason"] is None
    assert len(provider.calls) == 1


def test_long_code_block_triggers_strict_retry() -> None:
    """First response has a long fence → retry with strict prompt → returns clean response."""
    bad = "Here is code:\n```python\na = 1\nb = 2\nc = 3\nd = 4\ne = 5\n```"
    good = "Think about the complement of each number."
    provider = MockProvider([bad, good])
    engine = HintEngine(provider)
    hint, meta = engine.generate_hint(
        make_attempt(), make_problem(), "def solution(): pass", depth=1
    )
    assert hint == good
    assert len(provider.calls) == 2
    # The retry call's system prompt was strengthened.
    assert "IMPORTANT" in str(provider.calls[1]["system"])
    assert "IMPORTANT" not in str(provider.calls[0]["system"])
    assert meta["used_fallback"] is False


def test_double_failure_uses_fallback() -> None:
    """Both calls fail the filter → fall back to problem.fallback_hints[depth-1]."""
    bad = "```python\na=1\nb=2\nc=3\nd=4\ne=5\n```"
    provider = MockProvider([bad, bad])
    engine = HintEngine(provider)
    hint, meta = engine.generate_hint(
        make_attempt(), make_problem(), "def solution(): pass", depth=1
    )
    assert hint == "Think about lookups."  # fallback_hints[0]
    assert meta["used_fallback"] is True
    assert meta["fallback_reason"] == "output_filter_failed_twice"
    assert len(provider.calls) == 2


def test_provider_exception_uses_fallback() -> None:
    """Provider raises → engine never propagates, uses fallback."""

    class BrokenProvider:
        def generate(self, system: str, user: str, max_tokens: int = 400) -> str:
            raise RuntimeError("network error")

    engine = HintEngine(BrokenProvider())
    hint, meta = engine.generate_hint(make_attempt(), make_problem(), "", depth=2)
    assert hint == "Use a hash map."  # fallback_hints[1]
    assert meta["used_fallback"] is True


def test_depth_clamped_to_valid_range() -> None:
    """depth=0 and depth=99 should both work without raising."""
    provider = MockProvider(["A hint."] * 10)
    engine = HintEngine(provider)
    hint_low, meta_low = engine.generate_hint(make_attempt(), make_problem(), "", depth=0)
    hint_high, meta_high = engine.generate_hint(make_attempt(), make_problem(), "", depth=99)
    assert hint_low and hint_high
    assert meta_low["depth"] == 1  # clamped up
    assert meta_high["depth"] == 3  # clamped down


def test_depth_instruction_in_user_message() -> None:
    """The depth-specific instruction appears in the user message, not the system prompt."""
    provider = MockProvider(["Hint."])
    engine = HintEngine(provider)
    engine.generate_hint(make_attempt(), make_problem(), "", depth=2)
    user_msg = str(provider.calls[0]["user"])
    assert "2/3" in user_msg
    # System prompt should NOT vary with depth (other than the strict-retry suffix).
    assert "depth: 2" not in str(provider.calls[0]["system"]).lower()


def test_fallback_clamps_index_to_available_hints() -> None:
    """If a problem has only 2 fallback hints and depth=3, return the last one."""
    provider = MockProvider(["```python\n" + "x=1\n" * 10 + "```"] * 2)
    problem = make_problem(fallback_hints=["nudge", "deeper"])
    engine = HintEngine(provider)
    hint, meta = engine.generate_hint(make_attempt(), problem, "", depth=3)
    assert hint == "deeper"
    assert meta["used_fallback"] is True


def test_fallback_handles_empty_hint_list() -> None:
    """If a problem somehow has no fallback hints, return the hardcoded default."""
    provider = MockProvider(["```python\n" + "x=1\n" * 10 + "```"] * 2)
    problem = make_problem(fallback_hints=[])
    engine = HintEngine(provider)
    hint, meta = engine.generate_hint(make_attempt(), problem, "", depth=1)
    assert "data structure" in hint.lower()
    assert meta["used_fallback"] is True


def test_metadata_includes_latency_ms() -> None:
    provider = MockProvider(["fast"])
    engine = HintEngine(provider)
    _, meta = engine.generate_hint(make_attempt(), make_problem(), "", depth=1)
    assert isinstance(meta["latency_ms"], int)
    assert meta["latency_ms"] >= 0


# --- Output filter unit tests -------------------------------------------------


def test_filter_passes_short_fence() -> None:
    assert not _response_has_long_code_block("```python\nx = 1\n```")


def test_filter_passes_no_fence() -> None:
    assert not _response_has_long_code_block("Just prose, no code fences here.")


def test_filter_catches_long_fence() -> None:
    assert _response_has_long_code_block("```python\na=1\nb=2\nc=3\nd=4\n```")


def test_filter_catches_long_fence_among_short_ones() -> None:
    """If ANY fence is too long, the response fails the filter."""
    text = (
        "Here's a one-liner:\n```python\nx = 1\n```\n"
        "And here's a long one:\n```python\na=1\nb=2\nc=3\nd=4\ne=5\n```"
    )
    assert _response_has_long_code_block(text)


def test_filter_at_exactly_three_lines_passes() -> None:
    """Boundary: 3-line fences are allowed; 4+ are not."""
    three_line = "```\na\nb\nc\n```"
    assert not _response_has_long_code_block(three_line)
