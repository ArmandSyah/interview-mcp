# Offline content authoring and release validation

Keep the private curriculum, drafts, review records, and source notes in your private authoring repository.
Do not put these files in this runtime checkout.
Installers contain only the five public coding examples and five development design briefs.

These tools validate a file that you select.
They do not examine private repositories or copy drafts into installers.
They do not call a model, contact checkout, publish content, or install content.

## Draft contract

A draft is a `tools.curriculum.DraftManifest`.
It contains the runtime pack fields: `format_version`, `pack_id`, `title`, `version`, `coding`, and `design`.
It also contains these fields:

- `workflow_stage: "draft"` and `review_status: "unreviewed"`.
- `ownership: "original"` and `authored_with: "ai-assisted"` or `"human"`. Use the value that agrees with the source history.
- `created_at`, with a UTC offset. UTC means Coordinated Universal Time.
- `curriculum`: one lesson for each practice item, in prerequisite order.

Each lesson has these fields:

- `problem_id`: the practice item ID.
- `skill_targets`: one to six skill targets.
- `recall_prompts`: three prompts in plain English.
- `prerequisites`: unique IDs of lessons before this lesson. The default is an empty list. The maximum is 20 IDs.
- `practice_modes`: `guided`, `mock`, or the two values, without duplicates.

The default practice modes are `guided` and `mock`.
Each skill target and recall prompt must contain 1 to 500 characters and cannot contain only whitespace.
The curriculum must contain 1 to 200 lessons.

This sequence gives a possible practice order.
It does not create a calendar or show that you can complete an interview task.

The runtime validator examines pack IDs, hints, test fixtures, starter code, and design rubrics.
Each practice item ID must be unique and use the pack namespace.
Each coding item must have three hints and positional JSON test fixtures.
Its starter code can contain only permitted function definitions.
Each design rubric must have six sections, with requirements, constraints, and failure scenarios.

Draft design revisions must be empty. The runtime calculates revision fingerprints.
The validator parses starter code as an abstract syntax tree (AST).
It does not execute starter code on the host.
Function defaults and annotations cannot execute calls or access external objects.

From the runtime checkout, enter this command to validate a draft:

```bash
uv run python -m tools.curriculum validate /absolute/private/path/pack.draft.json
```

Validation is read-only by default. It does not initialize SQLite.
With `--report /absolute/private/path/validation-report.json`, the command writes a new private report.
It does not replace a file.
The report contains a SHA-256 hash of the normalized content and lesson plan.
It always contains `publishable: false`.

Structural validation does not show who wrote the questions or if answers and hints are correct.
It does not give approval for sale.
Correct JSON fixtures and function signatures do not show that expected answers are correct.
Do not copy third-party interview content.
Do not record approval without a review.

## Review-bound compilation

Human practice pilots are not necessary for work on these tools.
Content approval is necessary before a paid release.
No command creates approval automatically.

A reviewer supplies a `ReviewApproval` JSON file with these fields:

- `format_version: 1` and `decision: "approve-release"`.
- The report's `content_sha256`.
- Their actual `reviewer` identity and `reviewed_at`, with a UTC offset.
- Each exercise ID one time in `reviewed_ids`.
- All five `attestations`: `original-content`, `contract-clarity`,
  `hint-progression`, `no-solution-code`, and `rubric-not-a-grade`.

Changes to normalized questions, hints, authorship metadata, lessons, or recall prompts invalidate that approval.
JSON whitespace and key order do not change the approval hash.
The review time must be at or after the creation time.
The release time must be at or after the review time.

An approval file is a review record, not cryptographic proof of identity.
Before you sign a package, make sure that the named reviewer supplied its approval.

```bash
uv run python -m tools.curriculum build /absolute/private/path/pack.draft.json \
  --approval /absolute/private/path/content-approval.json \
  --released-at 2026-10-10T00:00:00Z \
  --output /absolute/private/path/pack.release.json
```

Compilation creates an unsigned runtime manifest.
It removes the draft stage, authorship metadata, and lesson plan.
It validates the runtime pack contract again.
Atomic, exclusive file creation prevents replacement of a saved release.
After a write error, no incomplete output file stays at the final path.

Keep the draft, approval, and test evidence in your private repository.

## Signing and installation

After content approval, the owner can use the signing tool:

```bash
uv run python -m tools.distribution pack \
  --manifest /absolute/private/path/pack.release.json \
  --private-key /absolute/private/key-location/content-ed25519.pem \
  --output /absolute/private/path/pack.signed.json
```

Keep the private signing key in a different directory from this repository and the installer build inputs.
The signing tool rejects drafts.
Customer licenses use a different owner-operated command.
These tools do not configure checkout, collect payments, store payment data, or deliver purchases automatically.

The app rejects signed packs until the owner configures a trusted public key.
Do not change trust configuration only to view an unreviewed draft.

On Linux and macOS, the tools create reports and compiled files with mode 0600.
On Windows, use an access control list (ACL) to prevent unauthorized access to the authoring directory.
Keep permanent work in directories that the operating system does not clean automatically.

## Verification

```bash
uv run pytest -q tests/test_curriculum.py tests/test_content_packs.py
uv run ruff check server tools tests
uv run mypy server tools
```

These commands do tests of the command-line interface (CLI), review hashes, prerequisites, and starter code validation.
Tests also include invalid JSON, private file creation, interrupted writes, and signed pack installation.
Approval records in these tests are fixtures, not production approvals.
