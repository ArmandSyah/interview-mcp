# Interview Workbench desktop guide

The desktop app has coding and system-design workspaces.
The Electron main process starts the Python MCP engine with a private stdio connection.
A virtual private server (VPS), domain, and hosted database are not necessary.

AI is off at first startup. The app keeps the provider that you select.
Curated hints are available without a model or API key.
The Docker sandbox is necessary for code execution, but not for canvas practice.
See the [app terms](../../docs/terminology.md) and [public release plan](../../docs/public-release-plan.md).

## Run from source

Install Git, Node.js 24, and uv.
Use Python 3.12. uv can download Python when necessary.

Enter these commands from the repository root:

```bash
uv sync --frozen --dev --python 3.12
cd apps/desktop
npm ci
npm run install:electron
npm run dev
```

The app starts the MCP engine automatically.
Do not start a second Python server for the desktop app.
The app uses curated hints when your shell contains a paid provider key.

Close the window to stop the development process.
After changes to main-process code, stop the app. Start the app again.
Vite reloads renderer changes during development.

### Linux requirements

Use a graphical desktop with GTK and X11 libraries.
On Ubuntu 24.04, install the missing Electron libraries:

```bash
sudo apt-get update
sudo apt-get install libnss3 libasound2t64
```

For headless UI tests, also install `xvfb`.
WSLg is necessary to show an app window in WSL.
Use a native Windows build if WSLg is unavailable.

Linux packages use Ubuntu 24.04 as the build host.
The tests do not include earlier glibc versions.

### Troubleshooting

| Problem | Action |
| --- | --- |
| The engine reports a missing Python environment. | Enter `uv sync --frozen --dev --python 3.12` from the repository root. |
| Electron reports a missing executable. | Enter `npm run install:electron` from `apps/desktop`. |
| Electron reports a missing shared library. | Install the Linux libraries in the requirements section. |
| Linux has no display. | Start a graphical desktop. Use Xvfb only for headless tests. |
| Code tests fail to connect to Piston. | Complete the optional sandbox setup below. |
| The coach panel is disabled. | Select a provider in Settings, or use curated hints with AI off. |
| A saved design or database reports damage. | Keep the existing files. Restore from a different backup before you continue. |

Do not disable the Electron sandbox to bypass a setup error.

## Use a packaged app

The desktop workflow creates Windows NSIS installers and Linux AppImage and deb packages.
These packages include Python, the MCP engine, and the public examples.
Node.js, uv, and the source checkout are not necessary to start these packages.

The workflow artifacts are unsigned development builds.
They are not a published, signed release. Windows can display a SmartScreen warning.

For a local Linux preview, enter these commands from `apps/desktop` after the package build:

```bash
chmod +x "release/Interview Workbench-0.2.0.AppImage"
"./release/Interview Workbench-0.2.0.AppImage"
```

If FUSE is unavailable, start the AppImage with `--appimage-extract-and-run`:

```bash
"./release/Interview Workbench-0.2.0.AppImage" --appimage-extract-and-run
```

This option extracts the package to a temporary directory before startup.
It does not disable the Electron sandbox.
See the [AppImage FUSE guide](https://docs.appimage.org/user-guide/troubleshooting/fuse.html) for the runtime's requirements.

## Enable code execution

The app does not execute solution code in the editor or your host Python.
Tests use Piston in a local Docker container.

1. Install Docker with Compose.
2. Start Docker.
3. Open **Settings**.
4. Select **Check local sandbox**.
5. Read the privileged-container warning.
6. Select **Enable local execution** only on a trusted workstation.

Internet access is necessary for setup to download the image and Python runtime.
The app uses a digest-pinned image.
It examines the Docker connection, container platform, and cgroup version.
The bundled image does not support ARM64 Docker engines.

A privileged container can change its host system.
CAUTION: Use local execution only on a trusted workstation or an isolated Docker virtual machine (VM).
Privileged software can change host files. This can cause data loss.
Do not use a shared production host.
The app rejects remote Docker contexts and TCP or SSH daemon endpoints.

After setup, each code execution request starts the app-owned sandbox if it is stopped.
The app stops that container after five idle minutes or on exit.
The runtime volume stays available for the next practice session.
Settings can stop the container or disable automatic startup.

The app examines ownership labels before it manages a container.
It can use an external Piston instance if that instance has Python 3.12 installed.
It does not stop that external instance or install its runtime.

### Manual sandbox setup

For manual setup, enter these commands from the repository root:

```bash
docker compose -f compose.desktop.yml up -d --wait --wait-timeout 180
uv run python -c "import httpx; r=httpx.post('http://127.0.0.1:2000/api/v2/packages', json={'language':'python','version':'3.12.0'}, timeout=300); r.raise_for_status()"
```

Without uv, use curl for runtime installation:

```bash
curl --fail --max-time 300 http://127.0.0.1:2000/api/v2/packages -H 'Content-Type: application/json' --data '{"language":"python","version":"3.12.0"}'
```

In Windows PowerShell, use `curl.exe`, not `curl`.
As an alternative, use:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:2000/api/v2/packages -ContentType application/json -Body '{"language":"python","version":"3.12.0"}' -TimeoutSec 300
```

The sandbox listens on `127.0.0.1:2000`.
Do not expose this port to the internet.
The execution configuration disables solution networking and limits memory, output, and concurrent runs.

Stop the manual container from the repository root:

```bash
docker compose -f compose.desktop.yml stop
```

This Compose project is not the app-owned project.
The app does not stop the manual container for you.

## Coding practice

Open a problem. Write your implementation.
Select **Run tests** to do tests of the saved draft.
Select **Submit** to complete the attempt only if all tests pass.

After an edit, the app marks the previous test results stale.
It saves drafts automatically and requests a save before exit.
Use `Ctrl/Cmd+S` to save immediately.
Use `Ctrl/Cmd+Enter` to start tests.

The app records the problem revision for each attempt.
A catalog update does not replace the problem text of an existing attempt.

## System-design practice

Select **System design**. Open one of the five development briefs.
Use Excalidraw or the component palette to draw your design.
Enter your explanation in the six note sections.

The app bundles fonts and canvas assets.
It disables remote embeds and external canvas links.
It stores imported raster images in local files.

Guided mode includes curated hints. Mock mode disables those hint controls.
The timer can start and pause. The draft keeps the elapsed time.

**Checkpoint** captures immutable evidence.
**Review** shows discussion coverage, not architectural correctness or hiring readiness.
Edits after a design review can make that design review stale.
**History** first saves the draft, then restores a saved checkpoint.

After you examine the saved evidence, select **Finish practice**.
Export an Excalidraw file, a PNG image, or a JSON file with the canvas and notes.

## Optional AI coach

Open **Settings**. Select a provider in the **AI coach** section.

- **Off:** the app makes no model calls. Curated hints stay available.
- **Ollama:** use a local, tool-capable model. Install the model. Start the model.
- **Claude API:** use your Anthropic API key. Each chat request has an API charge.

The app does not install a model or make background chat requests.
A paid provider receives your message, applicable practice text, and tool results when you send a chat.
Model responses can contain errors.

The coding coach can request hints, tests, descriptions, and progress with permitted MCP tools.
The app supplies the saved draft and attempt ID.
User approval is mandatory for submission. The coach cannot edit the code or use a shell.
Select **Stop** to cancel a turn.

The system-design coach receives an immutable checkpoint of notes and diagram labels.
It cannot change the canvas, notes, reminders, or session status.
It does not receive image files and cannot read text in those images.

Diagram summaries support up to 3,000 elements.
Labels longer than 2,000 characters have an explicit shortened-label marker.
The full text stays in the canvas and exports.
A summary of more than 700 KB causes an error before checkpoint creation. The saved draft does not change.

The main process stores credentials with OS secure storage when available.
Snapshots and the Python process do not receive API keys.
Without secure storage, keys stay in memory until exit. Enter the keys again after you start the app.
Practice files are not encrypted.

## Recall and reflection

Open **Practice queue** from the coding workspace or the system-design workspace.
Add a saved coding or design attempt.
The app does not add reminders automatically.

Use **Due now**, **Upcoming**, or **Paused** to see reminders.
Select a reminder interval from 0 to 365 days.
Move, pause, or resume a reminder without removing its history.

Use **Recall & reflect** to answer plain-English prompts.
Record your answer, the help you received, and your next step.
The app saves reflection drafts automatically and requests a save before exit.

The **Save reflection & next review** action creates an immutable history record.
Self-ratings suggest reminder intervals of 1, 3, 7, 14, or 30 days.
You can change the suggested reminder.
These ratings do not measure correctness or complete the initial attempt.

AI, Docker, and a hosted service are not necessary for the queue.
The coach cannot read queue history or change reminders.
The app has no background reminder notifications.

## Local storage and backups

The engine uses SQLAlchemy 2.x with local SQLite.
It stores attempts, content revisions, design checkpoints, reviews, reflections, and installed-pack records.
Canvas documents and image assets use app-owned local files.

Database upgrades create a backup before migration.
The app refuses a database from a newer schema version.
Desktop state uses versioned atomic writes.

Settings can export a private practice archive.
The archive contains practice data, image assets, and installed content, but no credentials.
There is no archive restore UI.
Keep the archive private because it contains personal data.

The app uses different workspaces for different remote server and key identities.
The default public catalog has five coding examples and five design briefs.
To use a larger corpus, select an accepted runtime JSON export in Settings.
Do not select a private authoring repository.

Signed pack and update verification exists, but production trust keys are not configured.
No checkout or public update service is configured.
These features refuse untrusted input.
The [content guide](../../docs/content-authoring.md) gives the owner's content release procedure.

## Build and check

After the source setup, enter these commands from `apps/desktop`:

```bash
npm run backend
npm run build
npm run format:check
npm run typecheck
npm test
npm run test:desktop
npm run dist -- --publish never
```

Installers appear in `apps/desktop/release`.
Use `npm run package` for an unpacked build.
These commands prepare packages for the host operating system.

Linux headless tests can use:

```bash
xvfb-run -a npm run test:desktop
```

Set `INTERVIEW_DESKTOP_EXECUTABLE` to an unpacked executable to do packaged tests.
Copy the unpacked app outside the checkout before the source independence tests.

Model tests use fixtures and make no paid API calls.
Native tests include editor drafts, MCP tools, canvas images, exports, checkpoint restore, and recall.
For code execution UI tests, set `INTERVIEW_DESKTOP_TEST_PISTON=1` after manual sandbox setup.

For managed sandbox tests, set `INTERVIEW_DESKTOP_TEST_MANAGED_SANDBOX=1`.
Use a trusted Docker host with port 2000 free.
This test downloads the runtime and keeps its volume.
The default unit tests do not include this integration.

Builds collect project, font, and dependency notices.
Some packages have no published notice file.
Examine that inventory before a production release.

See [demo capture](../../docs/media/README.md) to regenerate the public GIFs and screenshots.
