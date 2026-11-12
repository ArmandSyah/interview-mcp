# Frontend verification

This audit covers the desktop app and its sign-in, download, and payment website.
It adds paced visual evidence to the existing automated regression suite.
It does not change normal app behavior or shorten existing test deadlines.

## Evidence rules

Each walkthrough uses disposable data. Real services and fixtures must be identified in its captions and manifest.
Each step states an expected result and checks it before the screenshot.
The recorder pauses for one second before the action and three seconds after the verified result.
GIF timing follows measured capture intervals. Slow screenshots must not shorten playback.
GIF captions occupy a separate strip below the app image. They cannot cover controls or disappear behind native dialogs.
PNG screenshots show the app without captions or the pointer marker.

The manifest records the source commit, working tree state, steps, timing, and control labels.
It does not record input values or link destinations in the control inventory.
The verifier reads actual GIF timing and checks each PNG, then writes file hashes.
Failed captures remain failed. Evidence tests have no retries.

## Run the walkthroughs

Install the normal desktop development dependencies and FFmpeg with the `subtitles` filter.
The CI workflow uses `imageio-ffmpeg==0.6.0` for the encoder.
Set `FFMPEG_PATH` if FFmpeg is not on `PATH`.
On Linux, use an isolated X display or `xvfb-run`.
From `apps/desktop`, run:

```sh
npm run build
npm run test:evidence
npm run verify:evidence
```

The output is in `apps/desktop/test-results-evidence`.
The HTML test report is in `apps/desktop/playwright-evidence-report`.
These directories are ignored by Git. Review captures before distribution.
The normal `npm run test:desktop` command keeps its existing test behavior.
The `Frontend visual evidence` workflow runs these recordings on Linux and Windows.
It retains screenshots, GIFs, manifests, traces, and reports for 14 days.
These walkthroughs use temporary local data and require no account credentials.

## Coverage inventory

This inventory identifies existing regression tests and the visual work still required.
A test filename is a coverage reference, not proof that the current run passed.
Recorded results must identify the tested commit and any skipped cases.

| Surface and interactions | Existing regression coverage | Paced evidence |
| --- | --- | --- |
| Welcome, search, difficulty filters, problem selection, statement and solution tabs, files, progress | `workbench`, `navigation-stories`, `content-stories`, `progress-view` | Initial coding walkthrough implemented |
| Editor typing, clipboard, shortcuts, autosave, restart, panel resizing | `editor-shortcuts`, `save-races`, `late-draft-navigation`, `panel-resize` | Draft capture implemented; remaining flows pending |
| Run tests, result details, stale results, errors, submit, follow-up questions | `result-stories`, `workbench`, `action-races` | Pending real execution walkthrough |
| Curated hints, coach input, stop, tool results, approval, rejection, clear history, AI review | `chat-input`, `chat-cancellation`, `approval-stories`, `chat-history`, `ai-review` | Real curated hint implemented; remaining flows pending |
| Design catalog, attempts, mode switch, notes, timer, guided/mock mode, checkpoint, history, review, finish | `design-controls`, `design-finish`, `design-review-navigation`, `design-completion-recovery` | Initial design walkthrough implemented |
| Whiteboard tools, components, text, selection, move, delete, undo/redo, zoom, menus, export | `canvas-pointer`, `design-artifacts`, `inactive-design-drafts` | Components and pointer tools implemented, including labels, move, delete, undo/redo, zoom, clear, and restart; remaining menus and export pending |
| Practice queue add, filters, open, reschedule, pause/resume, recall, reflection, rating, history | `practice-queue-stories`, `practice-queue-create`, `practice-queue-open`, `practice-queue-races` | Reminder changes, filters, reflection history, and draft recovery after restart implemented |
| Settings, local/remote connection, account credentials, provider fields, browse, save, cancel, focus and errors | `settings-stories`, `settings-recovery`, `account-settings`, `settings-error-focus`, `credential-recovery` | Provider choices, cancellation, URL errors, notices, and local reconnect implemented; remaining flows pending |
| Sandbox status, enable, progress, cancel, stop, close | `sandbox-setup`, `sandbox-close`, `sandbox-status-races` | Pending |
| Content packs, license, workspace backup, release channel, signed update, installer, notices | `distribution-stories`, `signed-update`, `update-close`, `solution-export` | Pending; unavailable preview controls must be identified |
| Native windows, close, startup failure, file dialogs, failed saves and recovery | `window-controls`, `startup-recovery`, `file-dialog-recovery`, `close-races` | Pending |
| Website desktop/mobile layout, navigation, workspace switch, download links and notices | `site/test/browser-qa.mjs` | Pending |
| Website private signup, sign-in, validation, sign-out, account status and failures | `site/test/browser-qa.mjs` | Pending |
| Website checkout, payment link, status refresh, cancellation, HTTPS portal and account races | `site/test/browser-qa.mjs`, recorded real sandbox acceptance | Pending fresh visual proof; no live charge |

Regression filenames above are relative to `apps/desktop/tests/e2e` and end in `.spec.ts`, unless an explicit path is shown.
Embedded whiteboard menus require direct inspection as part of this audit.
The final report must name remaining gaps rather than treat a partial recording as complete coverage.

### Embedded whiteboard controls

Direct inspection found additional controls beyond the main shape toolbar.
The More tools menu exposes frames, web embeds, a laser pointer, and Mermaid import.
The Library panel has canvas item storage, a public library link, search, and an options menu.
The Help dialog has keyboard shortcuts and external resource links.
These controls still need behavior tests and paced recordings.
Opening these panels alone does not verify their actions or saved data.

## Delivery

Review the screenshots and representative GIF frames before sending them.
The final email must contain pictures or GIFs, test totals, the source commit, fixed bugs, and remaining limits.
Use the connected Gmail account as the recipient, as requested.
No email has been sent for this audit yet.
