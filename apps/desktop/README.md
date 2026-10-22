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

### Chat input and history tests

In coding mode, Enter sends the message and Shift+Enter inserts a line break.
During text composition, Enter stays with the input method.
The app does not send the message.
In design mode, Enter inserts a line break.
Use Send design message to send that question.
These mode differences do not change.

Each composer has a limit of 8,000 UTF-16 code units.
UTF-16 is the 16-bit Unicode Transformation Format.
A code unit is one 16-bit value in this text encoding.
The limit includes spaces and line breaks.
Some characters, such as 🙂, use two code units.
Messages with only whitespace do not start a chat.

More Send actions cannot start a different chat while a chat is active.
New composer text stays available while the app saves drafts before a chat.
A provider error keeps the question and response text received before the error.
The error does not replace a newer unsent question.
A new chat clears the active error indicator.
The provider error is also a saved system message.

The desktop bridge method `clearChat()` has no parameters and returns `Promise<void>`.
In coding mode, it clears the selected problem conversation.
If no problem is selected, it clears the welcome conversation.
In design mode, it clears the selected design conversation.
The method rejects a busy service or a missing design session.
An empty conversation stays empty.

The coding workspace has a Clear conversation button.
There is no history-clear button in the design workspace.
The method does not change other conversations, drafts, attempt status, or account ownership.
Unsent composer text stays available after a clear.

Draft writes before the clear complete first.
New code, design, and recall writes wait for the clear result.
The editors accept edits during this interval.

The app keeps the history until its disk write completes without an error.
If a draft write before the clear fails, the method rejects and keeps the history.
History write failures also keep the history.
The retry clears only that conversation after the write completes without an error.

`LocalStore.persist(state)` is an internal storage method.
Its optional `state` parameter supplies a full workspace snapshot.
Without that parameter, the method uses the active store state.
The method writes `workspace.json` and returns `Promise<void>` after the write completes.
It rejects a write failure or a store that has not loaded.
It does not replace the state in memory.

The history clear writes a staged snapshot before it changes memory.
The saved data format stays the same.

After the build, run these tests from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/chat-input.spec.ts tests/e2e/chat-recovery.spec.ts tests/e2e/history-save-races.spec.ts
```

The tests use local response fixtures and isolated workspaces.
They do not run a model.
The composition test sends browser events to the app renderer.
It does not test input methods from the operating system.
The history tests include write failures, retry, restart, and code edits during a history clear.
Service tests also include design notes and recall drafts during a history clear.

### Settings and account tests

The settings correction changes failure behavior, not the saved data format.
Draft paths, saved attempts, and account ownership stay the same.
Settings and credentials in memory change only after the settings write completes without an error.
An encryption failure or disk write failure keeps the previous settings, credentials, and connection.
The settings dialog keeps its form values for a retry.

The desktop bridge method `updateSettings(input)` returns `Promise<void>`.
The `input` parameter supplies settings and optional credential changes.
If the input has no credential or an empty credential, the app keeps the saved credential.
The `clearApiKey` and `clearMcpKey` flags remove their credentials, including when the input also supplies new credentials.
Without a credential store from the operating system, credentials stay in memory only.

The method rejects invalid settings, a busy service, encryption failures, and settings write failures.
It also rejects a draft write failure that occurs before the settings write.
A connection failure after the settings write does not undo the saved settings.
The snapshot shows the disconnected state and its error.
The app closes that connection and clears its catalogs and progress display.
It does not select a different account's workspace.

Settings saves and reconnections wait for draft writes in progress.
New code, design, and recall writes wait for the operation to complete.
After an account change, a queued draft write rejects without a write to the new account's workspace.
A settings write failure releases queued drafts to the same workspace.
These operations use the same draft sequence control as history clear.

When you disable the managed sandbox, the app saves that selection before it stops the container.
A settings write failure does not stop the container.
If the stop returns an error, the app keeps the saved settings and completes its connection request.
The settings method then rejects with a message that identifies the saved settings and stop failure.
The sandbox consent requirement does not change.

A workspace contains local drafts, attempts, and chat history.
Local mode uses one workspace without an account.
A remote server can supply an account identity.
For these servers, each account has one workspace for each MCP URL.
Each such workspace is for one account.

Without an account identity, the remote workspace uses the server URL and credential.
Without this identity, a credential change can select a different workspace.
A new account can have an empty workspace.
For a server that supplies identity, a credential replacement for the same account keeps its workspace.

The `Snapshot.workspaceId` field identifies the selected local workspace.
This ID is not an account credential.
An editor model contains code and undo history.
The code editor uses the workspace ID and problem ID for its model.
Undo can restore text from the same account, but cannot insert a different account's text.

Unsent coding chat text stays with its workspace in memory until the app closes.
After an account change, the new account's composer cannot show unsent text from the previous account.

`LocalStore.bindAccount(mcpKey, account, state)` is an internal storage method.
The `mcpKey` parameter supplies the credential that the remote server accepted.
The `account` parameter supplies `userId` and `issuer` values from the authenticated remote server.
The `userId` identifies the account, and `issuer` identifies its authentication service.
The optional `state` parameter supplies the state to change.
Without this parameter, the method changes the active store state.

The method returns the workspace ID and updates the credential and account maps in that state.
It rejects local connection settings and does not write files.
Connection setup writes staged maps before it changes the maps in memory.
A map write failure keeps the previous maps and closes the new connection.
The app does not move saved workspace files.

After the build, run these tests from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/settings-recovery.spec.ts tests/e2e/account-settings.spec.ts
```

The native tests use a local protocol fixture and temporary workspaces.
They include write failure, retry, token replacement, account changes, undo, unsent text, credential removal, and restart.
They do not test Supabase token verification or send model requests.
Service tests also include encryption failures, queued drafts, account map failures, and sandbox stop failures.

### Catalog and selection tests

Problem search matches the title, problem ID, tags, and pattern tags.
Search ignores letter case.
The search results must also match the difficulty filter.
The All filter includes all difficulties.
An empty search includes all problems that match the difficulty filter.
Search and filters do not change drafts or the selected attempt.

The file explorer selects saved coding attempts.
The `solution.py` tab shows the code editor.
The `problem.md` tab shows the problem description, not a different local file.
The file explorer keeps that tab selection when you select a different problem folder.
Each problem keeps its code draft.

The desktop bridge has three selection methods.
`activateProblem(id)` selects a saved coding attempt by its problem ID.
`activateDesign(sessionId)` selects a saved design attempt by its session ID.
`setMode(mode)` selects `coding` or `design`.
Each method returns `Promise<void>` after the selection write completes.
The methods do not add attempts or change code, notes, history, or self-ratings.

The methods reject a busy service or a write failure.
The attempt selection methods also reject an unknown saved attempt ID.
The bridge rejects a mode other than `coding` or `design`.
A selection of the same target also writes the selection.

Draft writes received before a selection complete first.
New draft writes wait for the selection result.
The app keeps its previous selection until the disk write completes without an error.
A write failure keeps that selection and releases queued drafts to the same workspace.
A retry can save the requested selection.
The saved data format and draft paths do not change.

Ctrl+S saves the code draft, and Ctrl+Enter starts a test request from the editor.
On macOS, these shortcuts use Command, not Ctrl.
Ctrl+S does not start a second save while a save is in progress.
A draft edit during a save waits for that save and then uses a new write.

A test request in progress prevents a second test request.
The Run tests shortcut selects the test-results panel.
A test request error keeps the draft and releases the controls.

After the build, run these tests from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/navigation-stories.spec.ts tests/e2e/editor-shortcuts.spec.ts
```

The navigation tests make disk writes return errors in temporary workspaces.
They include retry and restart for problem, mode, and saved design selections.
Service tests include draft writes before and during selection writes, with write success and failure.
The shortcut test holds requests at the desktop bridge and supplies a test request error.
It does not run the code draft.
The Piston stories run code in a local sandbox.

The Windows workflow uploads its `test-results` files after the native test step, including failure traces.
This makes the dialog state and operation sequence available when a Windows assertion reports an error.
The previous Windows run did not upload these files.

### Test reports and export errors

A test report contains the results for one coding attempt and its problem.
An attempt has no report before its first accepted test request.
The desktop keeps the last accepted report for each saved attempt.
The desktop validates each new report before it changes the result, completion state, or chat history.
This validation examines the report structure.
It does not test the code.

The report must identify the requested attempt and problem.
Its test counts must agree with its test cases.
Each test case has a different nonnegative integer index.
The summary shows success only when the report contains tests and all tests passed.
An empty test list has zero counts and `all_passed: false`.

The Python contract supplies defaults for omitted `user_stdout`, `user_stderr`, `error`, `wall_time_ms`, and `actual` fields.
The desktop uses the same defaults.
The desktop accepts more report fields, and UUID attempt IDs are not necessary.
Local execution reports keep their source and verification labels.

`parseTestReport(value, attemptId, problemId)` returns the validated report.
The `value` parameter contains the received report.
The `attemptId` and `problemId` parameters identify the requested attempt and problem.
An invalid report causes an error without state changes.

`parseSubmission(value, attemptId, problemId)` validates the submission fields and its test report.
Its `value` parameter contains the received submission response.
The ID parameters have the same meanings as in `parseTestReport`.
It returns the validated submission or throws an error without state changes.
The submission must contain a boolean completion value and a text message.
An omitted follow-up question value defaults to null.

A rejected response keeps the previous report, code draft, completion state, and chat history.
The desktop shows the error and releases the controls for retry.
The server can have completed its operation before the desktop rejects a response.
The desktop does not change server records after this error.

The display also validates saved reports from previous versions.
An invalid saved report shows an error, not test case data or counts.
The draft stays available, and a new accepted report can replace the invalid report.
This display check does not remove the invalid saved report or change the saved data format.

Test requests use the code captured when the request starts.
Edits during a request stay in the editor and use the usual draft save procedure.
The result shows `Results are for an older draft` when the saved code is different from the tested code.
A test report with all tests passed does not complete an attempt without submission.
A subsequent submission with failed tests does not change an attempt's completed state.

Solution, design, and practice backup exports use `writeExport(path, data)`.
The `path` parameter identifies the selected output file.
The `data` parameter contains a UTF-8 string or a byte array.
The function returns `Promise<void>` after file replacement.
It writes and syncs a temporary file in the selected directory before it replaces the output file.

A write, sync, close, or replacement error keeps the previous output file unchanged.
File replacement removes the temporary path after success.
The function removes its temporary file after failure.
It also shows a cleanup error if it cannot remove that file.
New export files use owner-only permissions where the operating system can apply these permissions.
Replacement changes the selected directory entry, not other hard links or a symbolic link's target.

The desktop export methods return the selected path after success or null after cancellation.
Cancellation does not change a previous output file.
Exports wait for draft saves in progress and prevent a second export request.
A solution export uses the captured draft when the editor receives new text while the file dialog is open.
Subsequent edits stay in the draft and can use a subsequent export.

After the build, run these tests from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/result-stories.spec.ts tests/e2e/solution-export.spec.ts
```

The result stories use a local protocol fixture, not a code execution service or a live account.
They include invalid responses, saved reports, duplicate requests, edits during requests, result displays, progress tabs, restart, and retry.
The export stories control the native file dialog and cause file writes to return errors in temporary directories.
Unit tests include report validation and export failures during file open, write, sync, close, and replacement.
The Piston stories run code in a local sandbox.

Export unit tests also include hard links and symbolic links.
The symbolic-link test does not run on Windows because link creation can need special operating system permissions.

### Long export filenames and coach recovery

Export filenames can use the limits of the selected filesystem.
The previous temporary filename included the selected filename and a suffix.
This could make the temporary filename too long.
The new temporary filename does not include the selected filename.
The temporary file stays in the selected directory for file replacement.
This change does not migrate saved data or change export contents.

The coding coach context contains the problem, code draft, and previous test counts.
The coding coach validates a saved test report before it uses the counts in its context.
An invalid report supplies a warning, not test counts.
The coach does not change the saved report or code draft.
A subsequent accepted test report can replace the invalid report.
The app shows context errors and enables the chat controls for a new request.

The export stories include a 223-character filename, duplicate requests, cancellation, retry, and edits during the file dialog.
The coach story uses an invalid saved report and starts the app again.
It sends two messages through a local provider fixture.
It examines the warning, saved draft, and controls after each reply.
The fixture does not contact a model provider.

### Electron failure traces

Each native test starts an Electron context trace after the first window loads its document.
The trace contains document snapshots, screenshots, and browser operations.
The Playwright runner trace contains test assertions.
These are different traces because the tests start Electron directly.

The test helper saves an `electron-*.zip` archive before it closes the app.
A native window close can stop Electron before the helper saves that archive.
The helper also writes trace files during the test to its `electron-*-raw` directory for this case.
The usual test configuration keeps output directories only for failures.
The output directory is `apps/desktop/test-results`.

The helper copies only platform environment variables from its list into the Electron process.
The test arguments set the workspace directory and development URL.
The helper does not copy other shell values, provider credentials, or `NODE_OPTIONS`.
Trace files can contain fixture requests and data from the test windows.
Use fixture accounts and credentials in native tests.

The trace tests use two expected assertion failures after they open the settings dialog.
They save a `settings.png` screenshot before the window closes.
Playwright accepts these expected failures.

One case closes the app through the helper.
The other case closes the native window first.
The verifier examines document snapshots, screenshot files, and the expected assertion messages.
A startup failure cannot give the expected assertion message.

The tests set a test environment value before the launch.
The verifier makes sure that launch metadata does not contain this value or its name.

After the build, run these tests from `apps/desktop`:

```bash
npx playwright test --config playwright.diagnostics.config.ts
uv run python scripts/check-desktop-traces.py
```

A display is necessary for the first Linux command.
On Linux without a display, use `xvfb-run -a` before the first command.
The trace tests keep all output in `test-results-diagnostics`, including the two expected failures.
The Linux and Windows workflows run these tests, examine the files, and upload the trace directories.
The application tests are also necessary.

### New attempt write failures

The desktop saves a new attempt before it changes the selected attempt.
The workspace record contains saved sessions and the selected session IDs.
A local write error keeps the previous selection and saved session list.
The error does not remove previous drafts, chat history, test reports, or design checkpoints.
The desktop shows the error, and you can retry.
Previous saved records keep their data format.

New attempt writes wait for draft writes in progress.
Edits received during the new attempt write wait for that write to stop.
Each edit keeps the ID of its problem or design session.
The desktop saves them to the previous attempt after success or failure of the new attempt write.
A selection change does not move a queued draft to a different attempt.

`startProblem(id)` opens a coding problem from the connected catalog.
The `id` parameter identifies that problem.
If the workspace contains an attempt for this problem, the method selects that attempt without new scaffold files.
If no saved attempt is available, it requests an attempt, description, and a progress report from the server.
It then saves the starter code and new workspace record before it changes the selection.
A progress request error prevents this local save and selection change.

`startDesign(problemId, newAttempt = false)` opens a design brief from the connected catalog.
The `problemId` parameter identifies the brief.
With `newAttempt: false`, the method selects the last saved session in progress for that brief, if available.
With `newAttempt: true`, or without a saved session in progress, it creates a new session.
It saves an empty design draft and the workspace record before it selects that session.

The two start methods return `Promise<void>`.
The promise resolves after selection or rejects on error.

A server can create its attempt before a description request or local write fails.
The desktop can contain draft files with no saved session reference after a local write error.
The desktop does not remove these server records or files.
A retry can create a new server attempt.

`LocalStore.saveCode(scope, session, state)` writes the code file and workspace record and does not change memory.
The `scope` parameter identifies the desktop workspace.
The `session` parameter supplies the problem ID and code.
The optional `state` parameter supplies the workspace snapshot and defaults to the active state.
The method returns `Promise<void>` after the two writes or rejects on an error.
New attempt creation changes the selected attempt only after the two writes complete without errors.

`DesignStore.load(scope, sessionId)` waits for previous writes, then reads the saved draft for that workspace and session.
The `scope` parameter has the same meaning as in `LocalStore.saveCode`.
The `sessionId` parameter identifies the design session.
The method returns the saved design draft or an empty draft for a file-not-found error.
It rejects invalid IDs or damaged data.
It does not replace the file after these errors.

A previous write failure does not prevent this read or a new draft save.
The read does not clear the previous write error from `flush()`.
After a subsequent write without an error, `flush()` returns without an error.

After the build, run the creation stories from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/attempt-creation.spec.ts
```

The four native stories cause draft and workspace write errors in coding and design practice.
They include duplicate clicks, edits during the write, error displays, retry, and restart.
They use the local MCP engine and temporary data directories.
Service tests include previous writes and queued edits during a new attempt write.
They include write success and failure.
Storage tests include supplied state snapshots and recovery after a failed design write.

### Edits during navigation

Navigation changes the selected attempt or practice mode.
Each navigation action first saves pending edits.
The user can change a draft while the navigation request waits.
That edit must keep its previous attempt ID if the design view closes before autosave starts.

`Workbench` is the parent component for the Coding and System design views.
It keeps pending design drafts and their autosave timer.
A design draft contains the canvas, notes, practice mode, and elapsed time for one design session.
The design view reads and changes that draft, but does not remove pending writes when it closes.

Each pending draft has one session ID.
A session can have no pending draft after its writes complete.
After a read, the design view uses the pending draft for that session, if available.
Without a pending draft, it uses the saved draft.
The autosave interval stays at 600 milliseconds after the last edit.

A change to Coding does not cancel the pending design save.
The desktop shows a save error in the active view, including Coding.
It keeps the pending draft after an error.
A subsequent navigation or window-close request retries the save.
If that retry fails, the requested navigation or window close does not occur.
Saved records keep their previous format, and no data migration is necessary.

After the build, run these stories from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/late-draft-navigation.spec.ts tests/e2e/inactive-design-drafts.spec.ts
```

The stories hold a navigation request after its first draft save.
They then change a draft before autosave starts and release the request.
They examine the previous attempt before a new action can save its draft.
They include coding and design edits, new attempts, mode changes, save failures, retry, window close, and restart.
The tests use the local MCP engine and temporary data directories.

### Account changes with pending code

The desktop keeps each account's practice data in its workspace.
The server identity identifies the account and the service that authenticates it.
The desktop uses the server identity to select an account workspace.
Different accounts can use the same problem ID.
A problem ID does not identify its account.

A pending draft contains edits without write confirmation.
System design actions save pending coding, design, and recall drafts before they continue.
This includes account changes in the settings dialog.
These actions use the same workspace save procedure as Coding.
The procedure includes drafts from each view.

A pending code write must complete before the account connection changes.
If the write fails, the desktop keeps the active account and the pending draft.
The settings dialog stays open with its entered values and the error.
A retry saves the draft to its account before the connection changes.
Saved records keep their previous format.
This change does not restore code from a previous overwrite.

After the build, run the account stories from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/account-draft-races.spec.ts tests/e2e/account-settings.spec.ts
```

The new stories use two accounts with the same coding problem ID.
They hold a mode change and add a code edit before autosave starts.
They then change accounts in System design settings.
The checks include displayed code, workspace IDs, different code files, save failure, duplicate submission, retry, and restart.
These stories use a local protocol fixture, not Supabase accounts or token verification.

### Settings errors after keyboard submission

The settings dialog keeps entered values after a rejected save.
A save error does not change saved settings.
The dialog moves keyboard focus to the error message and scrolls that message into view.
The Tab key then moves focus to **Save & connect**.
The Enter key retries the save.

When the save completes, the dialog closes.
The desktop then moves keyboard focus to **Open settings**.

After the build, run the keyboard stories from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/settings-error-focus.spec.ts
```

The stories submit settings with Enter from the Model field in a small window.
They include Coding and System design.
The checks include the error position, keyboard focus, saved settings, entered values, keyboard retry, and focus after the dialog closes.

### Design data during account changes

An unsent design question is text in the coach input field, not a saved chat message.
`Workbench` keeps one input value for each account workspace and practice mode.
The field can be empty.
Coding and System design use different values.

A token replacement for the same account keeps its unsent question.
An account change shows the new account's question, if available.
A change to Coding and back keeps the design question.
These questions stay in memory only.
App close discards them.
Saved messages and drafts keep their previous formats.

Design notes and canvas elements also stay with their account.
After an account connection error, the desktop must not show the previous account's draft.
A draft load or error from the previous account must not replace the selected account's data or error display.
The account tests use a local protocol fixture, not Supabase authentication.

After the build, run these stories from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/design-accounts.spec.ts
```

The stories include token replacement, account changes, mode changes, connection errors, draft loads after account changes, and restart.
They compare each account's saved notes and canvas elements.
They also examine unsent questions in the two practice modes.

### Reviews after a canvas load

A canvas binding connects one element to a different element, such as a label to its shape.
An element can have no bindings.
Excalidraw uses `null` or an empty list for that condition.
Its load procedure changes `null` to an empty list.
The load procedure must not invalidate a review if the canvas and notes do not change.

`canvasElements(elements, previous)` makes the element records for a saved scene.
The `elements` parameter supplies the new canvas records.
The `previous` parameter supplies the records from the active draft.
The function uses element IDs to find previous records.
It returns new records and does not change its inputs.

If the new binding list is empty, the function keeps a previous `null` value for that element ID.
Without that condition, it keeps the new binding value.
It keeps added elements, removals, element sequence, and changes to other fields.
It removes external links, as before.
The canvas and validated draft supply these typed inputs.
The function does not validate its inputs or write files.

Saved drafts and checkpoint hashes keep their previous formats.
The correction does not change previous checkpoints or reviews.
It does not restore a review that a previous save invalidated.
A new review checkpoint is then necessary.
Changes to diagram content continue to invalidate the review until the user makes a new review checkpoint.

After the build, run these stories from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/design-review-navigation.spec.ts
```

The stories include a mode change and app restart after a review.
They compare the canvas elements, evidence digest, and immutable review.
They also add a component and use **Review checkpoint** and **Finish practice**.
Unit tests include empty bindings, added and removed bindings, other element edits, element sequence, and external links.

### Design load recovery tests

The desktop reads a saved design draft when you open its session.
If the app cannot read that draft, the error bar shows **Retry canvas load**.
This button reads the same session again without a connection change.
More clicks before the response do not start a new retry.
The retry does not change the saved draft or its format.

You can select a different session while a draft read is in progress.
A response or error from the previous session cannot replace the new session's draft or error display.
A draft read without an error does not clear an error from a different action.
Connection errors keep the **Reconnect** button.
A retry does not repair a damaged draft file.

If the app cannot read checkpoint history, it keeps the draft and shows an error.
The **History** button retries that read.
More clicks before the response do not start a new history request.
After a response without an error, one history dialog opens.
Escape closes the dialog and puts keyboard focus on **History**.

After the build, run these stories from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/design-load-recovery.spec.ts tests/e2e/design-load-races.spec.ts
```

These tests use the local MCP engine and temporary data directories.
They include read errors, retries, history, and responses after a session change.
They compare saved files and notes before and after recovery.

### Reflection IDs and save retries

A reflection records a recall answer, reflection notes, a next step, and a self-rating.
Each saved reflection has one ID and cannot change.
A draft can have an ID without a saved reflection.
An edit to the answer, notes, next step, or self-rating makes a new ID for the draft.
An unchanged retry or a schedule-only change keeps that ID.
A new ID does not add a history record.

A save can complete before the desktop gets its response.
If you edit that draft, a new ID keeps the saved reflection unchanged.
A schedule conflict prevents the save.
Use **Refresh queue** to get the new schedule.
Then select **Use refreshed schedule**.
Save the reflection again.

An unchanged retry keeps one history record.
An edited draft can add a new history record.
Saved file formats and previous history records do not change.
This correction does not rewrite drafts from previous app versions.
These drafts can use an ID from a saved reflection.
The app makes a new ID when you edit that draft's content.

`editReflectionDraft(previous, next)` prepares the values for a local draft save.
The `previous` parameter supplies the draft before the edit.
The `next` parameter supplies the new values.
The function compares `answer`, `takeaway`, `next_action`, and `self_rating`.
Spaces and line breaks are part of the text.

A content change returns a new draft object with a new `reflection_id`.
Without a content change, the function returns `next`.
The function keeps the supplied `expected_version` and does not change its inputs.
It does not validate its typed inputs or write files.
It uses `crypto.randomUUID()`.
If this call throws an error, the function throws the same error.

### Queue filters and recovery tests

A reminder is due when its due time is at or before the desktop clock time.
Paused reminders do not show in **Due now** or **Upcoming**.
The desktop uses the date and practice filters together.
The **Practice type** filter selects Coding, System design, or Coding & design.
The **Due now** number includes reminders from the two practice types.

The desktop updates date filters at 30-second intervals without a server request.
Filter changes do not change saved reminders or history.

A queue item can identify an attempt that this desktop workspace does not contain.
Recall stays available for that item.
**Open saved practice** stays disabled.
The desktop does not open a different attempt.

After the build, run these stories from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/practice-queue-stories.spec.ts tests/e2e/practice-queue-races.spec.ts
```

These tests use the local MCP engine and temporary data directories.
They include practice filters, paused reminders, schedule conflicts, request errors, and save response errors.
The date test includes a reminder at its due time.
They also include duplicate clicks, attempts without local drafts, and edited recall after an app restart.
Unit tests examine ID changes for each content field and unchanged IDs after a schedule change.

### Queue creation and read recovery

After **Add to queue**, the desktop selects a date filter from the refreshed reminder.
The practice-type filter changes only if it does not show that reminder.
If the desktop does not get an add response, a retry can return the saved reminder.
The retry does not change that reminder's due time or paused state.
Use **Move reminder** to change its due time.
**Reminder delay (days)** accepts integers from 0 to 365.

After an initial queue read error, you can close and open the dialog again.
If the app cannot refresh the queue, it keeps the selected recall and its draft.
The app reads recall drafts and history before it changes the selected item.
If one read returns an error, the previous selection stays.
A response after the error cannot replace the next selection or its notes.

When the connected engine does not have queue tools, the dialog does not show local reminders or recall.
In local mode, you can use the saved local draft again.
Saved file formats, schedules, and history records do not change.

After the build, run these stories from `apps/desktop`:

```bash
npm run test:desktop -- tests/e2e/practice-queue-create.spec.ts tests/e2e/practice-queue-loads.spec.ts
```

These tests use the local MCP engine, temporary practice data, and a local remote-account fixture.
They include add retries, input validation, concurrent schedule changes, queue read errors, and recall responses after an error.
The connection test does not use Supabase accounts or change local notes.
