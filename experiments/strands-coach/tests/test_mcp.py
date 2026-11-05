"""Optional real-server test: INTERVIEW_SERVER_PYTHON=/path/to/python uv run pytest -q."""

import asyncio
import json
import os
import sqlite3
import subprocess
from pathlib import Path

import pytest
from test_coach import HINT, ScriptedModel

from coach import CoachTurn, Target, server_client


@pytest.mark.skipif(not os.environ.get("INTERVIEW_SERVER_PYTHON"), reason="No server interpreter.")
def test_real_stdio_coding_and_design(tmp_path):
    lab = Path(__file__).resolve().parents[1]
    repo = lab.parents[1]
    python = Path(os.environ["INTERVIEW_SERVER_PYTHON"])
    data = tmp_path / "data"
    setup = subprocess.run(
        [str(python), str(lab / "prepare_demo.py"), "--repo", str(repo), "--db-dir", str(data)],
        text=True,
        capture_output=True,
        check=True,
        timeout=30,
    )
    ids = json.loads(setup.stdout)
    targets = [
        Target(attempt_id=ids["attempt_id"]),
        Target(
            session_id=ids["session_id"],
            checkpoint_id=ids["checkpoint_id"],
        ),
    ]
    with sqlite3.connect(data / "interview_mcp.sqlite") as database:
        before = database.execute("select count(*) from attempts").fetchone()
    with server_client(repo, python, data) as client:
        for target in targets:
            turn = CoachTurn(
                client,
                target,
                ScriptedModel(
                    [
                        [("read_context", {})],
                        [("publish_hint", {"hint": HINT})],
                    ]
                ),
            )
            assert asyncio.run(turn.run("Give one hint.")) == HINT
            assert len(turn.context) > 100
    with sqlite3.connect(data / "interview_mcp.sqlite") as database:
        assert database.execute("select count(*) from attempts").fetchone() == before
        assert database.execute("select count(*) from events").fetchone() == (0,)
