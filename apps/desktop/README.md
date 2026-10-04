# Interview Workbench

A standalone, local-first interview practice app: problems on the left, a Monaco
Python editor in the middle, tests/progress below, and a coach panel on the right.
The desktop process connects to the actual Interview MCP engine over a private
stdio pipe. This is an interview workspace, not a VS Code extension host or a
general-purpose terminal.

No hosting account, VPS, or domain is needed. AI starts **off**. Browsing, editing,
autosave, progressive curated hints, and progress do not require an API key or a
local model. Nothing installs a model or sends a paid request automatically.

## Open the app

Packaged Windows NSIS installers and Linux AppImage/deb builds are produced by the
desktop workflow. They bundle Python and the MCP engine; Node, uv, and this source
checkout are not needed to use them. CI artifacts are unsigned development builds,
not a published or signed release. Windows may show a SmartScreen warning.

For development, install Node 24 and uv, then run from the repository root:

```bash
uv sync --frozen --dev
cd apps/desktop
npm ci
npm run install:electron
npm run dev
```

Linux needs a graphical desktop plus Electron's native libraries (on Ubuntu:
`libnss3`, `libasound2t64`, and the usual GTK/X11 desktop libraries). WSL users need
WSLg; a native Windows build avoids the WSL GUI dependency. Linux bundles are built
on Ubuntu 24.04 and are not tested against older glibc versions.

## Enable solution tests once

Code does **not** execute inside the editor or with unrestricted access to your
host Python. Tests use Piston's isolated execution environment. Install Docker
with Compose (Docker Desktop works on Windows), then from the repository root:

```bash
docker compose -f compose.desktop.yml up -d --wait --wait-timeout 180
uv run python -c "import httpx; r=httpx.post('http://127.0.0.1:2000/api/v2/packages', json={'language':'python','version':'3.12.0'}, timeout=300); r.raise_for_status()"
```

For packaged users without uv, the second step can instead use curl:

```bash
curl --fail --max-time 300 http://127.0.0.1:2000/api/v2/packages -H 'Content-Type: application/json' --data '{"language":"python","version":"3.12.0"}'
```

In Windows PowerShell use `curl.exe` rather than the older `curl` alias, or:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:2000/api/v2/packages -ContentType application/json -Body '{"language":"python","version":"3.12.0"}' -TimeoutSec 300
```

The sandbox listens only on `127.0.0.1:2000`; never expose that port publicly.
Piston requires a privileged container: use your own trusted workstation or an
isolated Docker VM, not a shared production host. Networking is disabled for
executed solutions, and runtime memory/output/concurrency limits are configured.
Package installation downloads the Python runtime once. Stop the container when
not practicing with `docker compose -f compose.desktop.yml stop`.

Open a problem, write your own implementation, then choose **Run tests**
(`Ctrl/Cmd+Enter`) or **Submit**. Submission marks the attempt complete only when
all tests pass. Editing after a run marks its results stale. `Ctrl/Cmd+S` saves;
the app also autosaves and flushes pending edits before closing. Export writes a
copy only to the location you select.

## Optional coach

Settings → AI coach offers:

- **Off:** no model calls; the Hint button uses the corpus's curated hints.
- **Ollama:** your already-installed local, tool-capable model. The default model
  name is `qwen3:4b`; install a suitable model yourself and start Ollama before
  enabling it. Local inference uses your machine's RAM/CPU/GPU, not a hosting bill.
- **Claude API:** your own Anthropic API key. This sends your message, selected
  problem, draft, recent chat, and relevant tool results to Anthropic and incurs
  their API usage charges when you send a message. There is no background chat.

The coach uses discovered MCP tool schemas, streams its answer, and displays tool
activity. It can read the problem, request one progressive hint per turn, test the
draft shared with that turn, and inspect progress. Submission requires your
approval. It cannot edit your files, run arbitrary shell commands, or substitute
model-generated code for your editor draft. Stop cancels a turn. These limits
support mentor-style practice; model answers are not guaranteed correct.

Keys stay out of the Python sidecar and snapshot/log payloads. Stored credentials
use Electron's OS secure storage when available; without a secure Linux keyring,
keys are memory-only and must be re-entered after restart. Workspace JSON is not
encrypted: it contains your drafts, chat, and problem text. Protect your device.

## Your larger question catalog

Packaged builds contain **five public examples only**. In Settings → Practice
engine, select the accepted runtime-export JSON directory from the private ops
repo to use your larger catalog. Do not select a whole authoring repo. Private
questions are never copied into installers. Strict corpus validation is preserved.

An optional remote MCP connection is also supported with HTTPS and a personal
bearer key; it is not required for local use. Different remote server/key
identities have separate saved workspaces.

## Build and verify

From `apps/desktop` after the development install:

```bash
npm run backend       # bundle the Python MCP engine with PyInstaller
npm run build
npm test
npm run test:desktop  # native graphical display required
npm run dist          # build an installer for the current OS
```

Linux headless CI uses `xvfb-run -a npm run test:desktop`. Enable the real Piston
UI test with `INTERVIEW_DESKTOP_TEST_PISTON=1` after sandbox setup. Set
`INTERVIEW_DESKTOP_EXECUTABLE` to an unpacked binary to test the packaged app.
Provider tests use wire-format fixtures and make no paid API calls; the UI chat
test uses a local test model endpoint and real MCP tools, not real model inference.
Desktop CI additionally checks real failing/passing code against Piston.

The renderer is isolated/sandboxed with a narrow IPC bridge, restricted navigation,
no Node integration, and a production CSP. App-owned state is saved in Electron's
user-data directory, shown in Settings. Source-checkout exercises are not modified.
