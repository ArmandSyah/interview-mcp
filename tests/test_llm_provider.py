"""
Unit tests for the LLM provider abstraction.

These tests never hit the network. They verify the Protocol shape, the factory
behavior, and that the concrete class satisfies the Protocol contract.
"""

from __future__ import annotations

import inspect

import pytest

from server.llm_provider import AnthropicProvider, LLMProvider, get_provider


def test_anthropic_provider_signature_matches_protocol() -> None:
    """
    Verify AnthropicProvider.generate has the exact signature LLMProvider requires.

    runtime_checkable isinstance() only checks method names, not signatures —
    so we inspect the signature explicitly. This catches the case where someone
    renames `system` to `prompt` and breaks the contract.
    """
    sig = inspect.signature(AnthropicProvider.generate)
    params = sig.parameters
    assert "system" in params
    assert "user" in params
    assert "max_tokens" in params
    assert params["max_tokens"].default == 400
    assert sig.return_annotation is str


def test_anthropic_provider_satisfies_protocol_statically() -> None:
    """
    Static-typing assertion: an AnthropicProvider instance is assignable to LLMProvider.

    If shape ever drifts, mypy fails on this line. Pytest also passes it at runtime.
    """
    provider: LLMProvider = AnthropicProvider.__new__(AnthropicProvider)
    assert provider is not None


def test_get_provider_returns_anthropic(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")
    provider = get_provider()
    assert isinstance(provider, AnthropicProvider)


def test_get_provider_defaults_to_anthropic(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")
    provider = get_provider()
    assert isinstance(provider, AnthropicProvider)


def test_get_provider_is_case_insensitive(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "ANTHROPIC")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")
    provider = get_provider()
    assert isinstance(provider, AnthropicProvider)


def test_get_provider_raises_on_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    with pytest.raises(ValueError, match="Unknown LLM_PROVIDER"):
        get_provider()


def test_anthropic_provider_missing_api_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """Constructor reads ANTHROPIC_API_KEY at instantiation time. Missing key = KeyError."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(KeyError, match="ANTHROPIC_API_KEY"):
        AnthropicProvider()
