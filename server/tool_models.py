from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ScaffoldFile(BaseModel):
    """A file the local client or agent should create in the user's workspace."""

    relative_path: str
    language: str
    contents: str
    sha256: str
    overwrite: bool = False


class StartProblemResult(BaseModel):
    attempt_id: str
    problem_id: str
    problem_title: str
    mode: Literal["local", "remote"]
    files_written: list[str] = Field(default_factory=list)
    files_to_create: list[ScaffoldFile] = Field(default_factory=list)
    instructions: str
