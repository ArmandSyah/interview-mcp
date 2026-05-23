import re
import time
from pathlib import Path

from server.db.schemas import AttemptRead, ProblemRead
from server.llm_provider import LLMProvider

_SYSTEM_PROMPT_PATH = Path(__file__).parent / "system_prompt.txt"
_CODE_FENCE_PATTERN = re.compile(r"```[\s\S]*?```", re.MULTILINE)
_MAX_FENCE_LINES = 3


def _count_fence_lines(fence: str) -> int:
    # A 3-line fence is ```\nline1\nline2\nline3\n``` which has 4 newlines.
    # We count newlines minus 1 to get content-line count.
    return max(0, fence.count("\n") - 1)


def _response_has_long_code_block(text: str) -> bool:
    for match in _CODE_FENCE_PATTERN.finditer(text):
        if _count_fence_lines(match.group()) > _MAX_FENCE_LINES:
            return True
    return False


_DEPTH_INSTRUCTIONS = {
    1: "Give a conceptual nudge only. Do not name specific data structures or algorithms.",
    2: "You may name the relevant data structure or pattern. Do not describe how to implement it.",
    3: "Describe the algorithm in natural language. Do not write any code.",
}


class HintEngine:
    def __init__(self, provider: LLMProvider):
        self._provider = provider
        self._system_prompt = _SYSTEM_PROMPT_PATH.read_text(encoding="utf-8").strip()

    def generate_hint(
        self,
        attempt: AttemptRead,
        problem: ProblemRead,
        current_code: str,
        depth: int,
    ) -> tuple[str, dict[str, object]]:
        """
        Generate a hint for the current attempt.

        Returns:
            (hint_text, event_metadata). event_metadata contains depth, latency_ms,
            used_fallback (bool), and fallback_reason (str | None).
        """
        depth = max(1, min(3, depth))
        user_message = self._build_user_message(problem, current_code, depth)

        start = time.monotonic()
        used_fallback = False
        fallback_reason: str | None = None

        hint = self._call_with_filter(user_message, strict=False)
        if hint is None:
            hint = self._call_with_filter(user_message, strict=True)
            if hint is None:
                used_fallback = True
                fallback_reason = "output_filter_failed_twice"
                hint = self._get_fallback(problem, depth)

        latency_ms = int((time.monotonic() - start) * 1000)

        metadata: dict[str, object] = {
            "depth": depth,
            "latency_ms": latency_ms,
            "used_fallback": used_fallback,
            "fallback_reason": fallback_reason,
        }
        return hint, metadata

    def _call_with_filter(self, user_message: str, strict: bool) -> str | None:
        system = self._system_prompt
        if strict:
            system += (
                "\n\nIMPORTANT: Your response must contain zero code fences. Plain English only."
            )
        try:
            text = self._provider.generate(system=system, user=user_message, max_tokens=400)
        except Exception:
            return None
        if _response_has_long_code_block(text):
            return None
        return text

    def _build_user_message(self, problem: ProblemRead, current_code: str, depth: int) -> str:
        examples_text = "\n".join(
            f"Input: {e.input}\nOutput: {e.output}\nExplanation: {e.explanation}"
            for e in problem.examples
        )
        constraints_text = "\n".join(f"- {c}" for c in problem.constraints)

        return f"""Problem: {problem.title}

        Description:
        {problem.description_md}

        Examples:
        {examples_text}

        Constraints:
        {constraints_text}

        The user's current code:
        {current_code}

        Hint depth: {depth}/3
        Depth instruction: {_DEPTH_INSTRUCTIONS[depth]}

        Provide a hint at exactly this depth."""

    def _get_fallback(self, problem: ProblemRead, depth: int) -> str:
        hints = problem.fallback_hints
        if not hints:
            return "Think about what data structure would let you look up values efficiently."
        index = min(depth - 1, len(hints) - 1)
        return hints[index]
