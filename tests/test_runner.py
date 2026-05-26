"""Unit tests for wrapper construction and result parsing."""

from __future__ import annotations

import pytest

from server.sandbox.runner import build_wrapper, extract_function_name, parse_result


def test_extracts_simple_function() -> None:
    assert extract_function_name("def two_sum(nums, target):\n    pass") == "two_sum"


def test_extracts_function_with_type_hints() -> None:
    code = "def pair_budget_match(prices: list[int], budget: int) -> list[int]:\n    pass"
    assert extract_function_name(code) == "pair_budget_match"


def test_extracts_first_function_when_multiple() -> None:
    code = "def helper():\n    pass\n\ndef main():\n    pass\n"
    assert extract_function_name(code) == "helper"


def test_ignores_comments_that_look_like_functions() -> None:
    code = "# def not_a_real_function():\ndef real(x):\n    return x"
    assert extract_function_name(code) == "real"


def test_async_function_supported() -> None:
    assert extract_function_name("async def go():\n    pass") == "go"


def test_no_function_raises() -> None:
    with pytest.raises(ValueError, match="No top-level function"):
        extract_function_name("x = 1\ny = 2")


def test_wrapper_includes_user_code() -> None:
    user_code = "def f(x):\n    return x * 2"
    wrapper = build_wrapper(user_code=user_code, function_name="f", test_input=[3])
    assert user_code in wrapper


def test_wrapper_calls_function_with_inputs() -> None:
    wrapper = build_wrapper(
        user_code="def f(x, y): return x + y",
        function_name="f",
        test_input=[1, 2],
    )
    assert "[1, 2]" in wrapper
    assert "f(*" in wrapper


def test_wrapper_uses_aliased_json_import() -> None:
    wrapper = build_wrapper(
        user_code="import json\ndef f(): return json.dumps([1])",
        function_name="f",
        test_input=[],
    )
    assert "_interview_mcp_json" in wrapper


def test_parses_simple_result() -> None:
    stdout = "__INTERVIEW_MCP_RESULT__\n[1, 2]\n"
    user_out, result, err = parse_result(stdout)
    assert result == [1, 2]
    assert err is None
    assert user_out == ""


def test_separates_user_stdout_from_result() -> None:
    stdout = "debug line 1\ndebug line 2\n__INTERVIEW_MCP_RESULT__\n42\n"
    user_out, result, err = parse_result(stdout)
    assert result == 42
    assert "debug line 1" in user_out
    assert "debug line 2" in user_out
    assert err is None


def test_missing_delimiter_returns_error() -> None:
    stdout = "Traceback (most recent call last):\n  ...\n"
    user_out, result, err = parse_result(stdout)
    assert result is None
    assert err is not None
    assert "delimiter not found" in err
    assert "Traceback" in user_out


def test_invalid_json_after_delimiter_returns_error() -> None:
    stdout = "__INTERVIEW_MCP_RESULT__\nnot valid json\n"
    _, result, err = parse_result(stdout)
    assert result is None
    assert err is not None
    assert "not valid JSON" in err


def test_empty_after_delimiter_returns_error() -> None:
    stdout = "__INTERVIEW_MCP_RESULT__\n"
    _, result, err = parse_result(stdout)
    assert result is None
    assert err is not None
    assert "no result line" in err


def test_complex_types_round_trip() -> None:
    stdout = '__INTERVIEW_MCP_RESULT__\n{"a": [1, 2], "b": null, "c": true}\n'
    _, result, err = parse_result(stdout)
    assert err is None
    assert result == {"a": [1, 2], "b": None, "c": True}
