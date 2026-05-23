from pathlib import Path

from server.db.schemas import AttemptRead, ProblemRead
from server.llm_provider import LLMProvider


_SYSTEM_PROMPT_PATH = Path(__file__).parent / "system_prompt.txt"

class HintEngine:
    def __init__(self, provider: LLMProvider):
        self._provider = provider
        self._system_prompt = _SYSTEM_PROMPT_PATH.read_text(encoding="utf-8").strip()

    def generate_hint(self, attempt: AttemptRead, problem: ProblemRead, current_code: str, depth: int) -> tuple[str, dict[str, object]]:
        # Implement hint generation logic here
        raise NotImplementedError("HintEngine.generate_hint() must be implemented")