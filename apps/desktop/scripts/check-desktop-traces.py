"""Verify the dedicated trace probe. This command only reads test artifacts."""

import json
import sys
from pathlib import Path
from typing import Any
from zipfile import ZipFile


def events(path: Path) -> list[dict[str, Any]]:
    if path.suffix == ".trace":
        return [json.loads(line) for line in path.read_bytes().splitlines()]
    with ZipFile(path) as archive:
        return [
            json.loads(line)
            for name in archive.namelist()
            if name.endswith(".trace")
            for line in archive.read(name).splitlines()
        ]


def screenshot_bytes(path: Path, name: str) -> bytes:
    if path.suffix == ".trace":
        return (path.parent / name).read_bytes()
    with ZipFile(path) as archive:
        return archive.read(name)


root = Path(sys.argv[1] if len(sys.argv) > 1 else "test-results-diagnostics")
runner_paths = list(root.glob("*/trace.zip"))
assert len(runner_paths) == 2, f"Expected two runner traces, found {runner_paths}"
archived = 0
for path in runner_paths:
    screenshot_path = path.parent / "settings.png"
    assert screenshot_path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"), (
        f"The settings screenshot does not have a PNG header: {screenshot_path}"
    )
    archives = list(path.parent.glob("electron-*.zip"))
    assert len(archives) <= 1, f"Expected at most one Electron archive, found {archives}"
    if archives:
        archived += 1
        context_path = archives[0]
        connection_paths = list(path.parent.glob("electron-*-connection.json"))
        assert len(connection_paths) == 1, (
            f"Expected one connection record, found {connection_paths}"
        )
        connection = json.loads(connection_paths[0].read_text())
        assert connection["version"] == 1 and not connection["truncated"], (
            f"Unexpected connection record format or truncation: {connection_paths[0]}"
        )
        assert any(
            row["event"] == "snapshot" and row.get("connection") == "connected"
            for row in connection["entries"]
        ), f"The connection record has no connected snapshot: {connection_paths[0]}"
        assert "fixture-value-must-not-enter-launch-options" not in json.dumps(connection), (
            f"The connection record contains an unrelated environment value: {connection_paths[0]}"
        )
    else:
        raw = list(path.parent.glob("electron-*-raw/context.trace"))
        assert len(raw) == 1, f"Expected one raw trace after native close, found {raw}"
        context_path = raw[0]
    context = events(context_path)
    snapshots = [event for event in context if event.get("type") == "frame-snapshot"]
    options = [event for event in context if event.get("type") == "context-options"]
    assert options, f"The Electron trace has no context metadata: {path.parent}"
    assert all(
        marker not in json.dumps(event)
        for event in options
        for marker in (
            "INTERVIEW_TRACE_SENTINEL",
            "fixture-value-must-not-enter-launch-options",
        )
    ), f"The trace contains an unrelated environment value: {path.parent}"
    assert snapshots, f"The Electron trace has no DOM snapshots: {path.parent}"
    assert any("Workbench settings" in json.dumps(event) for event in snapshots), (
        f"The Electron snapshots do not contain the settings dialog: {path.parent}"
    )
    screenshots = [event for event in context if event.get("type") == "screencast-frame"]
    assert screenshots, f"The Electron trace has no screenshots: {path.parent}"
    for screenshot in screenshots:
        data = screenshot_bytes(context_path, screenshot["file"])
        assert data.startswith(b"\xff\xd8") and data.endswith(b"\xff\xd9"), (
            f"The screenshot does not have JPEG boundary markers: "
            f"{context_path}, {screenshot['file']}"
        )
    runner = events(path)
    assert any(
        event.get("type") == "error"
        and "Intentional trace probe after settings opened" in event.get("message", "")
        for event in runner
    ), f"The runner did not record the intentional assertion failure: {path}"
assert archived == 1, f"Expected one archive and one raw trace, found {archived} archives"
print("Verified two Electron traces, DOM snapshots, screenshots, and intentional runner failures.")
