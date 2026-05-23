"""
Jailbreak detection — runs before any LLM call.

Matches against current_code and any free text the user passes in.
On match, returns a refusal string and the matched pattern name.
Add patterns as you discover new attack vectors.
"""

from __future__ import annotations

import re

_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("ignore_instructions", re.compile(r"ignore\s+(previous|prior|all)\s+instructions", re.I)),
    ("show_solution", re.compile(r"show\s+(me\s+)?(the\s+)?solution", re.I)),
    ("print_answer", re.compile(r"print\s+(the\s+)?answer", re.I)),
    ("reveal_code", re.compile(r"(reveal|give|output|display)\s+(me\s+)?(the\s+|a\s+)?(code|solution|answer)", re.I)),
    ("act_as", re.compile(r"act\s+as\s+(an?\s+|the\s+)?(senior|staff|principal|expert)", re.I)),
    ("roleplay", re.compile(r"(roleplay|pretend|imagine)\s+(you\s+are|you're|as\s+a)", re.I)),
    ("translate_solution", re.compile(r"translate\s+(the\s+)?solution", re.I)),
    ("write_function", re.compile(r"write\s+(the\s+)?(function|body|implementation|solution)", re.I)),
    ("what_would_code_look_like", re.compile(r"what\s+would\s+the\s+code\s+look\s+like", re.I)),
    ("pseudocode", re.compile(r"(pseudo[-\s]?code|pseudocode)\s+(for\s+)?(the\s+)?solution", re.I)),
]

_REFUSAL = (
    "I can't provide the solution directly — that defeats the purpose of the exercise. "
    "Ask me for a hint instead, and I'll nudge you in the right direction."
)


def check_jailbreak(text: str) -> tuple[bool, str | None]:
    """
    Check text for jailbreak patterns.

    Returns:
        (is_jailbreak, pattern_name). pattern_name is None if no match.
    """
    for name, pattern in _PATTERNS:
        if pattern.search(text):
            return True, name
    return False, None


def get_refusal() -> str:
    return _REFUSAL