import os
import time
from collections.abc import Sequence
from typing import Protocol, runtime_checkable

from anthropic.types import TextBlock


@runtime_checkable
class LLMProvider(Protocol):
    def generate(self, system: str, user: str, max_tokens: int = 400) -> str:
        pass


class GenerationResult:
    def __init__(self, text: str, latency_ms: int, input_tokens: int, output_tokens: int) -> None:
        self.text = text
        self.latency_ms = latency_ms
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


def _extract_text(content: Sequence[object]) -> str:
    """Return the text from the first TextBlock in a response content list.

    Raises ValueError if no TextBlock is present — which should never happen
    for a plain text completion without tools or extended thinking.
    """
    for block in content:
        if isinstance(block, TextBlock):
            return block.text
    raise ValueError(f"No TextBlock in response content: {content!r}")


class AnthropicProvider:
    MODEL = "claude-haiku-4-5-20251001"

    def __init__(self) -> None:
        super().__init__()
        from anthropic import Anthropic

        self._client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    def generate(self, system: str, user: str, max_tokens: int = 400) -> str:
        message = self._client.messages.create(
            model=self.MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return _extract_text(message.content)

    def generate_with_metatdata(
        self, system: str, user: str, max_tokens: int = 400
    ) -> GenerationResult:
        start = time.monotonic()
        message = self._client.messages.create(
            model=self.MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        latency_ms = int((time.monotonic() - start) * 1000)
        return GenerationResult(
            text=_extract_text(message.content),
            latency_ms=latency_ms,
            input_tokens=message.usage.input_tokens,
            output_tokens=message.usage.output_tokens,
        )


def get_provider() -> LLMProvider:
    name = os.environ.get("LLM_PROVIDER", "anthropic").lower()
    if name == "anthropic":
        return AnthropicProvider()  # <- AnthropicProvider.__init__ reads the API key here
    raise ValueError(f"Unknown LLM_PROVIDER '{name}'")
