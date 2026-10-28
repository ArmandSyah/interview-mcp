"""Check that missing trace evidence causes the artifact command to fail."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any
from zipfile import ZipFile

import pytest


@pytest.mark.parametrize(
    ("damage", "message"),
    [
        (None, "Verified two Electron traces"),
        ("metadata", "no context metadata"),
        ("dom", "no DOM snapshots"),
        ("dialog", "do not contain the settings dialog"),
        ("screenshot", "no screenshots"),
        ("image", "JPEG boundary markers"),
        ("sentinel_key", "unrelated environment value"),
        ("sentinel_value", "unrelated environment value"),
        ("assertion", "did not record the intentional assertion failure"),
        ("connection_missing", "Expected one connection record"),
        ("connection_duplicate", "Expected one connection record"),
        ("connection_version", "Unexpected connection record format or truncation"),
        ("connection_truncated", "Unexpected connection record format or truncation"),
        ("connection_state", "no connected snapshot"),
        ("connection_sentinel", "unrelated environment value"),
    ],
)
def test_trace_verifier_rejects_missing_evidence(
    tmp_path: Path, damage: str | None, message: str
) -> None:
    def encoded(events: list[dict[str, Any]]) -> bytes:
        return "\n".join(json.dumps(event) for event in events).encode()

    for native_close in (False, True):
        directory = tmp_path / str(native_close)
        directory.mkdir()
        (directory / "settings.png").write_bytes(b"\x89PNG\r\n\x1a\nfixture")
        context: list[dict[str, Any]] = [
            {"type": "context-options"},
            {"type": "frame-snapshot", "snapshot": "Workbench settings"},
            {"type": "screencast-frame", "file": "screencast/frame.jpeg"},
        ]
        failure = "Intentional trace probe after settings opened"
        # The verifier checks JPEG markers, not image decoding.
        image = b"\xff\xd8fixture\xff\xd9"
        if not native_close:
            if damage == "metadata":
                context = context[1:]
            elif damage == "dom":
                context = [context[0], context[2]]
            elif damage == "dialog":
                context[1]["snapshot"] = "Different dialog"
            elif damage == "screenshot":
                context = context[:2]
            elif damage == "image":
                image = b"not a screenshot"
            elif damage == "sentinel_key":
                context[0]["env"] = {"INTERVIEW_TRACE_SENTINEL": "fixture"}
            elif damage == "sentinel_value":
                context[0]["env"] = {"other": "fixture-value-must-not-enter-launch-options"}
            elif damage == "assertion":
                failure = "Fixture startup failure before the assertion"
        with ZipFile(directory / "trace.zip", "w") as archive:
            archive.writestr("test.trace", encoded([{"type": "error", "message": failure}]))
        if native_close:
            raw = directory / "electron-fixture-raw"
            (raw / "screencast").mkdir(parents=True)
            (raw / "context.trace").write_bytes(encoded(context))
            (raw / "screencast/frame.jpeg").write_bytes(image)
        else:
            connection = {
                "version": 1,
                "truncated": False,
                "entries": [{"event": "snapshot", "connection": "connected"}],
            }
            if damage == "connection_version":
                connection["version"] = 2
            elif damage == "connection_truncated":
                connection["truncated"] = True
            elif damage == "connection_state":
                connection["entries"] = [{"event": "snapshot", "connection": "connecting"}]
            elif damage == "connection_sentinel":
                connection["extra"] = "fixture-value-must-not-enter-launch-options"
            if damage != "connection_missing":
                (directory / "electron-fixture-connection.json").write_text(json.dumps(connection))
            if damage == "connection_duplicate":
                (directory / "electron-other-connection.json").write_text(json.dumps(connection))
            with ZipFile(directory / "electron-fixture.zip", "w") as archive:
                archive.writestr("trace.trace", encoded(context))
                archive.writestr("screencast/frame.jpeg", image)
    script = Path(__file__).resolve().parents[1] / "apps/desktop/scripts/check-desktop-traces.py"
    command = [sys.executable, str(script), str(tmp_path)]
    result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=10)
    expected = 0 if damage is None else 1
    details = (
        f"Call: {command!r}\nPrior artifact change: {damage!r}\n"
        f"Expected exit: {expected}\nActual exit: {result.returncode}\n"
        f"Expected message: {message!r}\nActual output: {result.stdout}{result.stderr}"
    )
    assert result.returncode == expected, details
    assert message in result.stdout + result.stderr, details
