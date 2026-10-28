# Offline content authoring and release validation

Keep the private curriculum, drafts, review records, and source notes in your private authoring repository.
Do not put these files in this runtime checkout.
Installers contain only the five public coding examples and five development design briefs.

These tools validate a file that you select.
They do not examine private repositories or copy drafts into installers.
The curriculum commands do not call a model, contact checkout, publish content, or install content.

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

## Question language review

`tools.language_review` examines a question file or an unreviewed draft manifest.
It reads the local ASD-STE100 Issue 9 PDF with its Part 2 dictionary.
The tool records dictionary entries, parts of speech, PDF pages, and possible rule errors.
The report identifies the specified context checks that a reviewer must complete.
The tool does not give an automatic conformity verdict or content approval.

Install the authoring dependencies:

```bash
uv sync --group authoring --dev
```

Download [Issue 9 from ASD](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf).
Keep the PDF outside the repository.
The repository does not contain a dictionary copy.

To examine one question without a model:

```bash
uv run --group authoring python -m tools.language_review audit /private/question.json \
  --item question-id --dictionary-pdf /private/ASD-STE100_ISSUE9.pdf \
  --report /private/question-language-report.json
```

Supply `--item` for each selected ID. Unknown or duplicate IDs cause an error.
The tool does not examine other files or repositories.
It accepts a standalone coding question, a standalone design question, or a `DraftManifest`.
Released manifests and signed packages are not draft inputs.
A missing coding or design array has no items.

For a candidate rewrite, install [Ollama](https://ollama.com/download).
Start Ollama before the model download.
The default model tag is `qwen3:4b-instruct`.

```bash
ollama pull qwen3:4b-instruct
uv run --group authoring python -m tools.language_review rewrite /private/question.json \
  --item question-id --dictionary-pdf /private/ASD-STE100_ISSUE9.pdf \
  --output /private/question-candidate.json --report /private/question-rewrite-report.json
```

`--ollama-url` defaults to `http://127.0.0.1:11434`. `--model` selects the installed model tag.
Only the rewrite command uses these arguments.

The tool examines model metadata before it sends question text.
It rejects cloud models, remote endpoints, redirects, and unknown model metadata.
It does not install a model or use a paid provider.
Each rewrite uses at most one model request, with no automatic retries.

The model returns proposed changes. Fields without proposed changes keep their previous text.
The report gives the number of changed fields. An empty set of changes does not show conformity.

In local tests, `qwen3:4b-instruct` repeated source text and paths. It did not correct a full question.
The tool rejected repeated paths. These results do not show that the model can make the necessary corrections.
You can select a different installed model or correct a candidate before the audit command.

The model receives only selected prose, declared terms, rule screens, and related dictionary alternatives.
It does not receive canonical solutions, private tests, example inputs or outputs, unselected items, or the full PDF.

The prompt has a maximum size of 24,000 UTF-8 bytes, including instructions and its JSON schema.
Each selected text field has a maximum of 20,000 characters.
The model context has 32,768 tokens. The maximum model output is 6,000 tokens.
The HTTP read timeout is 300 seconds. The response body has a maximum of 60,000 bytes.

### Editable text and protected data

| Source | Editable text |
| --- | --- |
| Coding | `description_md`, constraints, example explanations, and follow-up questions. |
| Design | `brief_md`, requirements, constraints, scenarios, and rubric prompts. |
| With `--include-hints` | Coding hints and common mistakes, or design hints. |

Titles, IDs, metadata, code, tests, example inputs and outputs, and unselected items keep their previous values.
Array lengths and indices do not change.
The tool also compares code blocks, quoted text, identifiers, numbers, operators, recognized formulas, and resource references.
These comparisons do not show that two sentences have the same meaning.
The reviewer must examine requirements, limits, negation, units, sequence, ownership, failures, and hint depth.

The tool protects hyphenated text as a possible formula by default.
For a prose word such as `non-overlapping`, add `--prose-hyphen non-overlapping`.
This argument lets the tool change that word outside code and quoted text.
It does not approve the word or its meaning.
Do not declare formulas as prose. A declaration removes their formula protection outside code and quoted text.

Supply each prose word one time. The word must occur in the selected text.
Use the same arguments when you audit the candidate.
The report records these declarations for independent review.

An AI rewrite cannot keep an `authored_with: "human"` claim.
The rewrite command rejects human-only drafts. The audit command can examine them.
New question text invalidates previous content approval.
The tool does not change installed content, saved attempts, or their pinned revisions.

### Reports, corrections, and errors

Each report identifies the selected IDs and paths, source hash, candidate hash, tool version, PDF hash, and requested model tag.
Content hashes use normalized JSON with UTF-8 text, sorted keys, and no separator whitespace.
JSON formatting outside text fields does not change these hashes.
The PDF hash identifies the bytes that the parser reads.

Counts show included items, excluded items, changed text fields, and text fields without changes.
Excluded items are the unselected items. The tool does not skip selected items.
The excluded leaf count includes protected scalar values and empty text fields.
An empty selection or an item without question text causes an error.

`entry_found` identifies a dictionary entry. It does not approve a word's contextual meaning or part of speech.
`form_review` identifies a possible base form for review.
`unapproved_entry` and `not_indexed` identify words that you must examine.

Rule screens identify long sentences, long paragraphs, semicolons, possible contractions, and `-ing` forms.
Their word counts are approximate. The reviewer must apply the standard's counting rules and sentence types.

With `--terms /private/terms.json`, supply up to 100 declared terms:

```json
{"terms": [{"text": "array", "kind": "technical_noun", "meaning": "An indexed sequence of values."}]}
```

Each term has `text`, `kind`, and `meaning`.
The permitted kind values are `technical_noun`, `technical_verb`, and `name`.
Declarations record proposed terms. A reviewer must examine their permitted use.

After you correct the candidate text, examine it with the same source and selection:

```bash
uv run --group authoring python -m tools.language_review audit /private/question.json \
  --item question-id --dictionary-pdf /private/ASD-STE100_ISSUE9.pdf \
  --candidate /private/question-candidate.json --report /private/corrected-language-report.json
```

The tool rejects protected changes before it writes a candidate.
Use new output paths. The tool does not replace source files or previous artifacts.
Each file write is atomic. The candidate and report are not one transaction.

If the report write has an error, the new candidate can stay without a report.
Do not use that candidate for release until its report and independent review are completed.

Exit code `0` shows that the tool wrote the report. It does not show conformity or release approval.
Exit code `2` identifies an input, model, or file error. Exit code `130` identifies a user interruption.
Malformed responses, tool requests, changed literals, and token-limit responses cause errors without automatic retries.
The source files keep their previous values after errors or interruption.

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
