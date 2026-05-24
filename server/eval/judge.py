"""
LLM-as-judge for hint quality evaluation.

The judge asks a narrow YES/NO question: does this hint convey a specific
concept? Golden tests use this to replace brittle keyword matching.
"""

from __future__ import annotations

from server.llm_provider import LLMProvider

_JUDGE_SYSTEM = (
    "You evaluate whether a coding interview hint conveys a specific concept. "
    "Respond with exactly one word: YES or NO. No explanation, no punctuation, "
    "no other words."
)

_JUDGE_USER_TEMPLATE = '''Problem context: {problem_title}

Hint given to the student:
"""
{hint}
"""

Concept the hint should convey: {concept}

Does the hint convey, point toward, or hint at this concept (even indirectly)? Answer YES or NO.'''


def hint_covers_concept(
    provider: LLMProvider,
    *,
    problem_title: str,
    hint: str,
    concept: str,
) -> bool:
    """Ask whether a hint covers a specific concept.

    Unrecognized responses count as False. This fail-closed behavior is useful
    for evals: if the judge ignores the YES/NO instruction, the fixture should
    fail rather than silently pass.
    """
    user = _JUDGE_USER_TEMPLATE.format(
        problem_title=problem_title,
        hint=hint,
        concept=concept,
    )
    response = provider.generate(system=_JUDGE_SYSTEM, user=user, max_tokens=4)
    return response.strip().upper().startswith("YES")
