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
A provider key in your shell does not enable AI automatically.

Close the window to stop the development process.
After changes to code in the Electron main process, stop the app.
Start the app again.
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
If WSLg is not available, use a native Windows build.

Linux packages use Ubuntu 24.04 as the build host.
Tests use that host's glibc version.

### Troubleshooting

| Problem | Action |
| --- | --- |
| The engine reports a missing Python environment. | Enter `uv sync --frozen --dev --python 3.12` from the repository root. |
| Electron reports a missing executable. | Enter `npm run install:electron` from `apps/desktop`. |
| Electron reports a missing shared library. | Install the Linux libraries in the requirements section. |
| Linux has no display. | Start a graphical desktop. Use Xvfb only for headless tests. |
| Code tests cannot connect to Piston. | Complete the optional sandbox setup below. |
| The coach panel is disabled. | Select a provider in Settings, or use curated hints with AI off. |
| A saved design or database reports damage. | Keep the files. Restore from a different backup before you continue. |

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

If FUSE is not available, start the AppImage with `--appimage-extract-and-run`:

```bash
"./release/Interview Workbench-0.2.0.AppImage" --appimage-extract-and-run
```

This method extracts the package to a temporary directory before startup.
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
The bundled image cannot operate on ARM64 Docker engines.

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
Do not make this port available to internet clients.
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
It saves drafts automatically and sends a save request before exit.
Use `Ctrl/Cmd+S` to save immediately.
Use `Ctrl/Cmd+Enter` to start tests.

The app records the problem revision for each attempt.
A catalog update does not replace the problem text of a saved attempt.

## System-design practice

Select **System design**. Open one of the five development briefs.
Use Excalidraw or the component palette to draw your design.
Enter your design notes in the six sections.

The app bundles fonts and canvas assets.
It disables remote embeds and external canvas links.
It stores imported raster images in local files.

Guided mode includes curated hints. Mock mode disables those hint controls.
The timer can start and pause. The draft keeps the elapsed time.

**Checkpoint** captures immutable evidence.
**Review** shows discussion coverage.
It does not show that a design is correct or that you can complete an interview task.
Edits after a design review can make that design review stale.
**History** first saves the draft, then restores a saved checkpoint.

After you examine the saved evidence, select **Finish practice**.
Export an Excalidraw file, a PNG image, or a JSON file with the canvas and notes.

## Optional AI coach

Open **Settings**. Select a provider in the **AI coach** section.

- **Off:** the app makes no model calls. Curated hints stay available.
- **Ollama:** use a local, tool-capable model. Install the model. Start the model.
- **Claude API:** use your Anthropic API key. Each chat request uses your paid API account.

The app does not install a model or make background chat requests.
A paid provider receives your message, applicable practice text, and tool results when you send a chat.
Model responses can contain errors.

The coding coach can get hints, test results, descriptions, and progress with permitted MCP tools.
The app supplies the saved draft and attempt ID.
User approval is mandatory for submission. The coach cannot edit the code or use a shell.
Select **Stop** to cancel a turn.

The system-design coach receives an immutable checkpoint of notes and diagram labels.
It cannot change the canvas, notes, reminders, or session status.
It does not receive image files and cannot read text in those images.

Diagram summaries can contain up to 3,000 elements.
Labels longer than 2,000 characters have a shortened-label marker.
The full text stays in the canvas and exports.
A summary of more than 700 KB causes an error before checkpoint creation. The saved draft does not change.

The Electron main process stores credentials with OS secure storage when available.
Snapshots and the Python process do not receive API keys.
Without secure storage, keys stay in memory until exit. Enter the keys again after you start the app.
Practice files are not encrypted.

## Recall and reflection

Open **Practice queue** from the coding workspace or the system-design workspace.
Add a saved coding or design attempt.
The app does not add reminders automatically.

Use **Due now**, **Upcoming**, or **Paused** to see reminders.
Select a reminder interval from 0 to 365 days.
Move a reminder or change its pause status. Its history does not change.

Use **Recall & reflect** to answer plain-English prompts.
Record your answer, the help you received, and your next step.
The app saves reflection drafts automatically and sends a save request before exit.

The **Save reflection & next review** button creates an immutable history record.
After a self-rating, the app shows an interval of 1, 3, 7, 14, or 30 days.
You can change that interval.
These ratings do not show that an answer is correct.
They do not complete the initial attempt.

AI, Docker, and a hosted service are not necessary for the queue.
The coach cannot read queue history or change reminders.
The app has no background reminder notifications.

## Local storage and backups

The engine uses SQLAlchemy 2.x with local SQLite.
It stores attempts, content revisions, design checkpoints, reviews, reflections, and installed-pack records.
Canvas documents and image assets use app-owned local files.

Database upgrades create a backup before migration.
The app rejects a database from a newer schema version.
Desktop state uses versioned atomic writes.

Settings can export a private practice archive.
The archive contains practice data, image assets, and installed content, but no credentials.
There is no archive restore UI.
Keep the archive private because it contains personal data.

The app uses different workspaces for different remote servers and account identities.
Supabase accounts keep the same workspace when an operator replaces an expired token.
Servers without account identity tools use bearer-key workspaces.
See the [Supabase preview guide](../../docs/supabase-hosting.md#desktop-connection) for manual account access and local execution reports.

The default public catalog has five coding examples and five design briefs.
To use a larger corpus, select an accepted runtime JSON export in Settings.
Do not select a private authoring repository.

The app verifies signed packs and updates, but production trust keys are not configured.
No checkout or public update service is configured.
These features reject untrusted input.
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

The build puts installers in `apps/desktop/release`.
Use `npm run package` for an unpacked build.
These commands prepare packages for the host operating system.

Linux headless tests can use:

```bash
xvfb-run -a npm run test:desktop
```

Set `INTERVIEW_DESKTOP_EXECUTABLE` to an unpacked executable to do packaged tests.
Copy the unpacked app to a different directory before the source independence tests.

Model tests use fixtures and make no paid API calls.
Native tests include editor drafts, MCP tools, canvas images, exports, checkpoint restore, and recall.
For code execution UI tests, set `INTERVIEW_DESKTOP_TEST_PISTON=1` after manual sandbox setup.

For managed sandbox tests, set `INTERVIEW_DESKTOP_TEST_MANAGED_SANDBOX=1`.
Use a trusted Docker host with port 2000 available.
This test downloads the runtime and keeps its volume.
The default unit tests do not include this integration.

Builds collect project, font, and dependency notices.
Some packages have no published notice file.
Examine that inventory before a production release.

See [demo capture](../../docs/media/README.md) to regenerate the public GIFs and screenshots.

### Save regression tests

The app keeps each draft until its disk write completes without an error.
Navigation and window close wait for edits that the app receives during a save.
An older snapshot must not replace a draft while its save is in progress.
A failed write keeps the draft available for another save.
These rules do not change the file formats or ownership of saved practice data.

The native save tests use temporary workspaces and the Electron app.
Each test sets when an inter-process communication (IPC) call starts.
The test can also supply an error instead of a call result.
Other calls use the app service and disk writes.
The tests include code drafts, design notes, recall answers, navigation, failed writes, window close, and restart.
Unit tests also examine concurrent save requests and retries after a disk failure.

After the build, enter this command from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/save-races.spec.ts
```

Playwright keeps a trace for each failed native test.
The trace includes the actions and assertions for that test.
The full UI audit is not completed.

### Action and settings regression tests

An action lock prevents concurrent workspace operations.
Settings and its dialogs use the same lock.
Draft autosave does not use this lock.
Settings controls stay disabled during file requests, sandbox checks, and connection changes.

If the app cannot start a chat request, the unsent message stays available.
It does not replace another message that you enter during the request.
Credential fields and removal checkboxes keep their values when you change the provider or connection.
Saved data formats and credential storage do not change.

After the build, enter this command from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/action-races.spec.ts tests/e2e/settings-stories.spec.ts
```

These tests include repeated actions before a service response and form values after a selection change.
They also include incorrect settings, directory picker cancellation, failed requests, and chat text recovery.
The service tests examine the busy state before each disk write completes and after a write failure.

### Dialog and startup regression tests

Settings, recall, and history dialogs prevent keyboard and pointer input to the workspace behind them.
These dialogs restore focus to their previous control after they close.
They do not replace focus that you move to a different control after the dialog closes.
Escape discards unsaved settings when no operation is in progress.
A backdrop click has the same effect.
A pointer drag from the settings dialog to its backdrop does not close the dialog.

For recall, Escape first saves the draft.
After a save failure, the dialog and draft stay available.
The dialog stays open during an operation, also after more than one Escape key press.
Checkpoint restore errors show in the history dialog.
The history dialog has a scrollable list of checkpoints.
Practice records and file formats do not change.

After an initial workspace request failure, the app shows an error and a retry button.
While a retry request is in progress, more clicks do not start a different request.
The app keeps workspace data from events that it receives before the initial request completes.
This retry does not repair a damaged workspace file.

After the build, enter this command from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/lifecycle.spec.ts
```

These tests include focus, Tab, Shift+Tab, Escape, save failures, backdrop clicks, checkpoint history, and response order.
The layout test sets the renderer viewport, which is the content area on the screen, to 1040 × 633.
It does not test native window resize controls.
The full UI audit continues.

### Window close and chat cancellation tests

A window close request prevents new workspace actions.
The app cancels active chat and waits for active interface actions.
It then saves all drafts.
The code editor accepts edits while a previous action or save is in progress.
Before its last save, the app prevents more input.
The app closes the window only after the last workspace write completes without an error.

The design timer stops while the close request is in progress.
After a close failure, it continues if it was active before the request.
A close error dialog keeps the workspace available.
The Continue practice button restores access after the error.
Saved data formats and record ownership do not change.

The service snapshot has a `busy` flag and a `chatId` field.
The `busy` flag prevents new practice actions and stays `true` through the last state write.
Draft saves do not use this flag.

Each active chat has a temporary universally unique identifier (UUID) in `chatId`.
The app keeps this ID in memory, not in practice files.
When no chat can accept cancellation, `chatId` is `null`.
Stop shows only when `chatId` is not `null`.

The desktop bridge method `cancelChat(chatId)` returns `Promise<void>`.
With an ID, it cancels only the chat with that ID.
After ID validation, the method returns without cancellation if no active chat has that ID.
Window close calls `cancelChat()` to cancel the active chat.
The method rejects invalid IDs and transport failures.
It does not change saved drafts.

The promise resolves after the cancellation request.
It does not wait for the last chat write.

Each Stop request uses the ID from its selected chat.
An ID from a completed chat cannot cancel a different chat.
A cancellation error keeps Stop available for a retry while that chat is active.
An error from a completed chat does not replace the error state of a different chat.
More clicks do not start a different Stop request for the same chat while cancellation is in progress.

After the build, enter this command from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/close-races.spec.ts tests/e2e/chat-cancellation.spec.ts
```

These tests include close during hints, chat, and submission approval.
They also include write failures, recovery from dialogs, timer state, and cancellation response sequence.
A local response fixture supplies the chat messages.
The tests do not run a model.

### Submission approval tests

Each submission request from the coach must have a different approval.
Each approval has an ID and one related chat.
A chat can have no approval or a sequence of approvals.
Only one approval can be pending at a time.
The app keeps approvals in memory, not in practice files.

Submit this draft starts tests on the code captured when you sent the message.
The tests must all pass before the service completes the attempt.
Edits after that message do not change the code for this submission.
Keep practicing and Escape reject the request.
A backdrop click does not select a decision.

The desktop bridge method `approve(id, allow)` returns `Promise<void>`.
The `id` parameter selects one pending approval.
The `allow` parameter is `true` for permission and `false` for denial.
The promise resolves after the service accepts the decision, not after submission tests.
The method rejects invalid, expired, and previously resolved IDs without a submission.
Transport failures also reject the promise.

While a decision request is in progress, the dialog prevents more decision requests.
The dialog shows transport errors before the service accepts a decision.
You can retry the decision while its approval is pending.
The approval expires after 60 seconds without a decision at the service.
Expiry and chat cancellation prevent submission.

The service sends `approval-settled` with the approval ID after a decision, expiry, or chat cancellation.
This event closes only the dialog for that approval.
A response or error from a completed approval cannot close a different approval or replace its error.
Saved drafts, chat history, and account ownership do not change.

After the build, run this command from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/approval-stories.spec.ts
```

The tests use a local provider fixture, not a model.
They include transport failures, more than one decision, expiry, and different response sequences.
Unit tests include the 60-second deadline and submission of the captured draft after more edits.

For the Piston execution test, first start the sandbox.
Set `INTERVIEW_DESKTOP_TEST_PISTON=1`.

The Piston test submits the starter draft without edits.
Its checks make sure that failed tests do not complete the attempt.
