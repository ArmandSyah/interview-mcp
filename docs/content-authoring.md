# Offline content authoring and release validation

Keep full private curriculum, drafts, review packets and source notes in your
private authoring repository, **outside this runtime checkout**. Installers still
contain only the five public coding examples and five development design briefs.
The tools here validate a supplied file; they do not discover private repositories,
copy drafts into installers, call a model, contact checkout, publish, or install.

## Draft contract

A draft is a `tools.curriculum.DraftManifest`: the runtime pack content fields
(`format_version`, `pack_id`, `title`, `version`, `coding`, and `design`) plus:

- `workflow_stage: "draft"` and `review_status: "unreviewed"`;
- `ownership: "original"` and truthful `authored_with: "ai-assisted"` or `"human"`;
- timezone-aware `created_at`;
- `curriculum`: one lesson for every practice item, in prerequisite order.

Each lesson has `problem_id`, 1–6 `skill_targets`, three plain-English
`recall_prompts`, earlier lesson IDs in `prerequisites`, and supported
`practice_modes` (`guided` and/or `mock`). This is a suggested learning sequence,
not an automatic calendar, mastery classifier, or hiring predictor.

The shared runtime validator requires unique pack-namespaced IDs, three coding
hints, valid positional JSON test fixtures, inert function-only starters, and
six-section design rubrics with requirements, constraints and failure scenarios.
Draft design revisions must be empty; revision fingerprints are assigned by the
runtime. Starter source is inspected as an AST, never executed on the host.
Function defaults and annotations cannot execute calls or access external objects.

Validate an existing draft from the runtime checkout:

```bash
uv run python -m tools.curriculum validate /absolute/private/path/pack.draft.json
```

Validation is read-only by default and does not initialize SQLite. An explicit
`--report /absolute/private/path/validation-report.json` writes a new private
report without overwriting an existing file. Reports bind the normalized content
and lesson plan with SHA-256, but always say `publishable: false`.

Structural validation cannot establish ownership, factual correctness, hint
quality, or suitability for sale. For coding content, checking JSON fixtures and
signature arity is not proof that expected answers are correct. Do not copy
third-party interview content or claim approval that did not happen.

## Review-bound compilation

Human practice pilots are not a gate to developing this pipeline. Actual content
approval for a future paid release is a separate ownership/quality decision.
There is deliberately no command that generates an approval automatically.

An approving reviewer supplies a separate `ReviewApproval` JSON with:

- `format_version: 1` and `decision: "approve-release"`;
- the report's `content_sha256`;
- their real `reviewer` identity and timezone-aware `reviewed_at`;
- every exercise ID exactly once in `reviewed_ids`;
- all five `attestations`: `original-content`, `contract-clarity`,
  `hint-progression`, `no-solution-code`, and `rubric-not-a-grade`.

Changing normalized question content, hints, authorship metadata or lesson/recall
content makes that approval stale. JSON whitespace/key order does not. Creation,
review and release timestamps must be in order. An approval file is a review
record, not cryptographic proof of the reviewer's identity: the owner must verify
its provenance before signing any resulting package.

```bash
uv run python -m tools.curriculum build /absolute/private/path/pack.draft.json \
  --approval /absolute/private/path/content-approval.json \
  --released-at 2026-10-10T00:00:00Z \
  --output /absolute/private/path/pack.release.json
```

Compilation creates an **unsigned** runtime manifest. It strips the draft stage,
authorship metadata and lesson plan, checks the installed-pack contract again,
and uses atomic, exclusive file creation. It cannot overwrite an earlier release;
failed writes do not leave a partial final artifact. Keep the draft and approval
packet privately for audit, including any independent test/correctness evidence.

## Signing and installation

Only after genuine approval, the owner may use the existing signing tool:

```bash
uv run python -m tools.distribution pack \
  --manifest /absolute/private/path/pack.release.json \
  --private-key /absolute/private/key-location/content-ed25519.pem \
  --output /absolute/private/path/pack.signed.json
```

The signing key must remain outside this repository and outside installer build
inputs. A draft cannot be passed directly to pack signing. Customer license
issuance is a separate explicit owner action; nothing here provisions checkout,
charges customers, stores payment information or performs automatic fulfillment.
The app still rejects signed packs until the owner configures a trusted public
key. Do not change trust configuration merely to preview an unreviewed draft.

On Linux/macOS reports and compiled artifacts are created with mode 0600;
Windows users must protect their authoring directory with appropriate ACLs.
Keep durable work out of OS-cleaned temporary directories.

## Verification

```bash
uv run pytest -q tests/test_curriculum.py tests/test_content_packs.py
uv run ruff check server tools tests
uv run mypy server tools
```

These exercise the real CLI, exact-review hash binding, prerequisite validation,
safe starter inspection, duplicate/non-finite JSON rejection, private/exclusive
artifact creation, interrupted-write cleanup and existing signed-pack installs.
The explicit approvals used in tests are fixtures, never production approval.
