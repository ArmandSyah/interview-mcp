"""
Golden conversation tests — eval suite for hint quality.

Run with:  RUN_GOLDEN_TESTS=1 uv run pytest tests/test_golden.py -v

These tests call the real Anthropic API and are excluded from normal CI.
Run them manually every time you change a prompt or the output filter.
Each fixture makes one hint-generation call and one judge call.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path

import pytest

from server.db import repo
from server.db.schemas import AttemptRead
from server.eval.judge import hint_covers_concept
from server.hints.engine import HintEngine
from server.llm_provider import LLMProvider, get_provider

pytestmark = pytest.mark.skipif(
    not os.environ.get("RUN_GOLDEN_TESTS"),
    reason="Set RUN_GOLDEN_TESTS=1 to run golden conversation tests",
)

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "golden"
CODE_FENCE = re.compile(r"```[\s\S]*?```", re.MULTILINE)


def _fence_line_count(text: str) -> int:
    return max(
        (max(0, f.count("\n") - 1) for f in CODE_FENCE.findall(text)),
        default=0,
    )


def _make_attempt(problem_id: str) -> AttemptRead:
    return AttemptRead.model_validate(
        {
            "id": "golden-test",
            "problem_id": problem_id,
            "language": "python",
            "status": "in_progress",
            "started_at": datetime.utcnow(),
            "completed_at": None,
        }
    )


@pytest.fixture(scope="module")
def provider() -> LLMProvider:
    return get_provider()


@pytest.fixture(scope="module")
def engine(provider: LLMProvider) -> HintEngine:
    return HintEngine(provider)


@pytest.mark.parametrize(
    "fixture_path",
    sorted(FIXTURES_DIR.glob("*.json")),
    ids=lambda p: p.stem,
)
def test_golden(
    fixture_path: Path,
    engine: HintEngine,
    provider: LLMProvider,
) -> None:
    fixture = json.loads(fixture_path.read_text())
    problem = repo.get_problem(fixture["problem_id"])
    assert problem is not None, f"Problem {fixture['problem_id']} not in DB"

    hint, meta = engine.generate_hint(
        attempt=_make_attempt(fixture["problem_id"]),
        problem=problem,
        current_code=fixture["current_code"],
        depth=fixture["depth"],
    )

    assert not meta["used_fallback"], (
        f"Engine fell back to pre-authored hint. Reason: {meta['fallback_reason']}. Hint: {hint}"
    )

    assertions = fixture["assertions"]

    if assertions.get("must_not_contain_code_fence_over_3_lines"):
        assert _fence_line_count(hint) <= 3, f"Long code fence in hint:\n{hint}"

    for banned in assertions.get("must_not_contain", []):
        assert banned not in hint, f"Banned string '{banned}' found in hint:\n{hint}"

    concept = assertions.get("concept")
    if concept:
        covered = hint_covers_concept(
            provider,
            problem_title=problem.title,
            hint=hint,
            concept=concept,
        )
        assert covered, (
            f"Judge ruled the hint does not cover the concept.\nConcept: {concept}\nHint:\n{hint}"
        )
