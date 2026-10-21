"""Compare public starter examples with their stated test contracts without execution."""

from __future__ import annotations

import ast
import doctest
import json
from pathlib import Path

import pytest

EXAMPLES = Path(__file__).resolve().parents[1] / "problems/examples"


@pytest.mark.parametrize("path", sorted(EXAMPLES.glob("*.json")), ids=lambda path: path.stem)
def test_starter_docstring_has_a_call_and_the_expected_return(path: Path) -> None:
    problem = json.loads(path.read_text())
    tree = ast.parse(problem["starter_code"]["python"])
    function = tree.body[0]
    assert isinstance(function, ast.FunctionDef), path.name
    docstring = ast.get_docstring(function)
    assert docstring, f"{path.name}: expected a starter docstring, actual=None"
    examples = doctest.DocTestParser().get_examples(docstring)
    assert len(examples) == 1, f"{path.name}: expected one example call, actual={examples!r}"
    call = ast.parse(examples[0].source).body[0]
    assert isinstance(call, ast.Expr) and isinstance(call.value, ast.Call), path.name
    assert isinstance(call.value.func, ast.Name), path.name
    actual = {
        "call": call.value.func.id,
        "arguments": [ast.literal_eval(argument) for argument in call.value.args],
        "return": ast.literal_eval(examples[0].want),
    }
    case = problem["test_cases"]["python"][0]
    expected = {"call": function.name, "arguments": case["input"], "return": case["expected"]}
    assert actual == expected, (
        f"{path.name}: after parsing the starter docstring, "
        f"expected={expected!r}, actual={actual!r}"
    )
    assert len(function.body) == 2 and isinstance(function.body[1], ast.Pass), (
        f"{path.name}: expected only a docstring and pass, actual={ast.dump(function)}"
    )
