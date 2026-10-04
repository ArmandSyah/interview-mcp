from pathlib import Path

root = Path(SPECPATH).resolve().parents[1]
a = Analysis(
    [str(root / "server/desktop.py")],
    pathex=[str(root)],
    binaries=[],
    datas=[
        (str(root / "problems/examples"), "problems/examples"),
        (str(root / "server/hints/*.txt"), "server/hints"),
    ],
    hiddenimports=["server.main", "server.db.models"],
    hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=[], noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [], exclude_binaries=True, name="interview-mcp",
    debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
    console=True, disable_windowed_traceback=False,
)
coll = COLLECT(
    exe, a.binaries, a.datas, strip=False, upx=False,
    name="backend",
)
