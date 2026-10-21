"""Pure pack contracts shared by draft validation, signing and installation."""

from __future__ import annotations

import ast
import json
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from server.db.content import ProblemContent
from server.design.schemas import DesignProblem

ID_PATTERN = r"^[a-z0-9][a-z0-9-]{0,30}$"
VERSION_PATTERN = r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"


def _safe_annotation(value: ast.expr) -> bool:
    if isinstance(value, ast.Name):
        return value.id in {"int", "float", "str", "bool", "list", "dict", "tuple", "set", "object"}
    if isinstance(value, ast.Constant):
        return value.value is None or value.value is Ellipsis or isinstance(value.value, str)
    if isinstance(value, ast.Subscript):
        return _safe_annotation(value.value) and _safe_annotation(value.slice)
    if isinstance(value, ast.Tuple):
        return all(_safe_annotation(item) for item in value.elts)
    if isinstance(value, ast.BinOp) and isinstance(value.op, ast.BitOr):
        return _safe_annotation(value.left) and _safe_annotation(value.right)
    return False


def validate_starter(problem: ProblemContent) -> None:
    """Inspect AST only. Never execute author-supplied code during validation."""
    tree = ast.parse(problem.starter_code.get("python", ""))
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
    if len(functions) != 1 or len(tree.body) != 1 or functions[0].decorator_list:
        raise ValueError("Starters must define one undecorated Python function.")
    function = functions[0]
    if function.type_params:
        raise ValueError("Starter type parameters are unsupported; use inert built-in annotations.")
    if any(
        not isinstance(node, ast.Pass)
        and not (
            isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        )
        for node in function.body
    ):
        raise ValueError("A starter may contain only a docstring and pass.")
    arguments = function.args
    parameters = [*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs]
    if arguments.vararg:
        parameters.append(arguments.vararg)
    if arguments.kwarg:
        parameters.append(arguments.kwarg)
    annotations = [argument.annotation for argument in parameters if argument.annotation]
    if function.returns:
        annotations.append(function.returns)
    if any(not _safe_annotation(annotation) for annotation in annotations):
        raise ValueError("Starter annotations must not execute calls or access external objects.")
    try:
        for value in [*arguments.defaults, *arguments.kw_defaults]:
            if value is not None:
                json.dumps(ast.literal_eval(value), allow_nan=False)
    except (ValueError, TypeError) as exc:
        raise ValueError("Starter defaults must be inert JSON-compatible literals.") from exc
    if any(value is None for value in arguments.kw_defaults):
        raise ValueError(
            "Test cases use positional arguments; required keyword-only parameters are unsupported."
        )
    cases = problem.test_cases.get("python", [])
    if not 1 <= len(cases) <= 100:
        raise ValueError("Each coding problem needs 1-100 Python test cases.")
    positional = len(arguments.posonlyargs) + len(arguments.args)
    required = positional - len(arguments.defaults)
    if any(
        len(case.input) < required or (not arguments.vararg and len(case.input) > positional)
        for case in cases
    ):
        raise ValueError("Test-case positional argument counts must match the starter signature.")


class Provenance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ownership: Literal["original"]
    review_status: Literal["human-reviewed"]
    reviewer: str = Field(min_length=1, max_length=200)
    reviewed_at: datetime


class PackContent(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    format_version: Literal[1]
    pack_id: str = Field(pattern=ID_PATTERN)
    title: str = Field(min_length=1, max_length=120)
    version: str = Field(pattern=VERSION_PATTERN)
    coding: list[ProblemContent] = Field(default_factory=list, max_length=100)
    design: list[DesignProblem] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def validate_content(self) -> PackContent:
        if not self.coding and not self.design:
            raise ValueError("A pack must contain practice content.")
        ids = [problem.id for problem in self.coding] + [problem.id for problem in self.design]
        if len(set(ids)) != len(ids) or any(
            not value.startswith(self.pack_id + "-") for value in ids
        ):
            raise ValueError("Use unique problem IDs inside the pack's namespace.")
        for coding in self.coding:
            validate_starter(coding)
            if len(coding.fallback_hints) != 3:
                raise ValueError("Each coding problem needs three progressive hints.")
        keys = {"requirements", "api", "data", "capacity", "tradeoffs", "failure_modes"}
        for design in self.design:
            if (
                design.pack_id != self.pack_id
                or len(design.rubric) != 6
                or {criterion.key for criterion in design.rubric} != keys
            ):
                raise ValueError("Design content needs this pack ID and all six rubric sections.")
            if not 10 <= design.time_budget_minutes <= 180:
                raise ValueError("Use a design time budget between 10 and 180 minutes.")
            if not design.requirements or not design.constraints or len(design.scenarios) < 3:
                raise ValueError(
                    "Design content needs requirements, constraints and three scenarios."
                )
        # JSON-compatible tests must not introduce NaN or Infinity into release artifacts.
        json.dumps(self.model_dump(mode="json"), allow_nan=False)
        return self


class PackManifest(PackContent):
    released_at: datetime
    provenance: Provenance

    @model_validator(mode="after")
    def validate_release(self) -> PackManifest:
        if self.released_at.tzinfo is None or self.provenance.reviewed_at.tzinfo is None:
            raise ValueError("Release and review timestamps need UTC offsets.")
        if self.provenance.reviewed_at > self.released_at:
            raise ValueError("Content must be reviewed before release.")
        return self


class LicenseClaims(BaseModel):
    model_config = ConfigDict(extra="forbid")
    format_version: Literal[1]
    license_id: UUID
    pack_id: str = Field(pattern=ID_PATTERN)
    subject: str = Field(min_length=1, max_length=200)
    issued_at: datetime
    updates_until: datetime
    perpetual: Literal[True]
