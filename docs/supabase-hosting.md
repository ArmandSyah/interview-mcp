# Supabase MCP preview

The Supabase Edge Function supplies a private practice preview.
It has coding catalogs, owned attempts, curated hints, and system-design tools.
It does not execute code. The desktop can execute remote attempts in local Docker.
The function stores the resulting reports as personal practice evidence.

The desktop uses the local Python engine and SQLite database by default.
Saved local attempts, drafts, and checkpoints do not change.

These two Model Context Protocol (MCP) tools identify the connection:

| Tool | Result |
| --- | --- |
| `ping` | Returns `pong`. |
| `get_connection_identity` | Returns the authenticated account ID, authentication issuer, and deployment status. |

The authentication issuer identifies the Supabase authentication service.
The identity result identifies one account. It contains only that account's identity.
A request without verified account credentials cannot execute tools.
The status result contains the available capabilities.
The function does not advertise unavailable execution, payment, or recall tools.

Account registration and desktop sign-in are not implemented.
Live tests verified account tokens, token replacement, owned practice, and local Docker execution.
The tests used two temporary accounts, then removed those accounts and their records.
They did not verify public registration or a desktop sign-in page.
Use the local engine for usual desktop practice.

## Desktop connection

An operator-supplied account session token is necessary for this private preview.
The app does not get or refresh that token automatically.
Do not use a project secret or a Supabase management credential as the account token.

1. Open **Settings**.
2. Select **Existing remote MCP**.
3. Enter the HTTPS function URL.
4. Enter the account token in **MCP bearer key or account token**.
5. Select **Save & connect**.

Hint requests contain the saved code draft.
Design tools receive notes and diagram summaries, not image files.
Local execution reports also go to the selected remote service.

The authenticated server supplies the account ID and authentication issuer.
The desktop does not decode a token to establish identity.
When you replace an expired token, the same account keeps its workspace.
Different accounts and server URLs have different workspaces.

Saved bearer-key workspaces keep their files and paths.
The first verified account connection can keep that credential's initial workspace.
It does not merge two account workspaces.
With a saved credential, the app can identify that workspace when the connection is unavailable.
Without OS secure storage, the token stays in memory until app exit.

## Hosted records

An account can have zero or more coding attempts and design sessions.
Each attempt or design session identifies one owner account.
Each record identifies one immutable content revision.
A content revision can have zero or more attempts or design sessions.
New catalog releases do not change saved records.

A design session can have zero or more checkpoints.
Each checkpoint identifies one session and the same account.
A checkpoint can have zero or more reviews. Each review identifies one checkpoint.

If a checkpoint retry has the same data, the function returns the saved record.
It does not create a new record.
A changed retry returns an error. A completed session cannot accept new checkpoints.
A review is necessary before the user can finish a session.

Notes use the same six sections as the local engine.
Each note can contain at most 5,000 characters.
A diagram can contain at most 3,000 elements.
Its normalized JSON representation can contain at most 700,000 UTF-8 bytes.
Reviews show discussion coverage. They do not show that a design is correct.

PostgreSQL row-level security controls access to account records.
The app accesses records through `iwb_practice`, a database function.
This interface is a remote procedure call (RPC).
That function gets the account ID from the verified request, not tool arguments.
Direct table access is not permitted for app accounts.

Account deletion removes that account's hosted practice records and reviews.
It does not remove local desktop records.

## Local code execution

Each remote attempt has a test plan from its saved content revision.
The desktop gets that plan through `get_local_execution_plan`.
It sends the user's code and one test input to local Piston for each test case.
Piston receives no MCP account token or model key.
The desktop does not execute this code in its host Python process.

After execution, `record_local_execution` stores the report with the same account and attempt IDs.
An attempt can have zero or more reports. Each report identifies one attempt.
The report contains results, output, errors, and a code fingerprint.
It does not include a source-code field. Output or errors can contain text from the code.

The function compares reported results with the saved test cases.
It cannot show which code executed. Reports contain `verification: not_server_verified`.
**Run tests** does not finish an attempt.
**Submit** finishes an attempt only if all reported results pass.
The UI identifies these results as local reports, not server-verified grades.

A repeated report ID returns the saved result if its data stays the same.
Different data with the same ID causes an error. Earlier reports do not change.

The desktop accepts plans with 1 to 100 Python test cases.
Code can contain at most 100,000 UTF-8 bytes.
The runtime gives each test three seconds and 256 MiB of execution memory.
For each test, the report limits standard output and standard error to 4,000 characters each.
The desktop identifies shortened output.

The desktop rejects integers below -9007199254740991 or above 9007199254740991.
The desktop rejects result JSON above 15,000 UTF-8 bytes.
PostgreSQL also limits each stored result representation to 16,000 bytes.
The full report must fit 850,000 bytes in its PostgreSQL JSON representation.

The desktop supplies **Run tests** and **Submit** through this local adapter.
The Edge Function does not expose remote `run_tests` or `submit_solution` tools.
The coach cannot call the internal plan or report tools directly.
A local execution adapter is necessary for an external MCP client to use these tools.

### Report parameters and results

`get_local_execution_plan` accepts one `attempt_id`, the UUID of an owned coding attempt.
It returns that attempt's ID, problem ID, content revision, Python function name, runtime version, and test cases.
Each test case has positional `input` arguments and an `expected` JSON result.
An attempt that is not in the account's records causes an error.
A plan must have 1 to 100 test cases.

`record_local_execution` accepts these parameters:

| Parameter | Meaning |
| --- | --- |
| `attempt_id` | UUID of the owned attempt. |
| `execution_id` | Caller-supplied UUID for one immutable report and safe retries. |
| `code_digest` | SHA-256 of the UTF-8 source code. It identifies the draft, not proof of execution. |
| `submitted` | Boolean. `true` requests submission. `false` records a test run without completion. |
| `tests` | One ordered report for each saved test case, with no omitted cases. |

Each test report has `index`, `actual`, `user_stdout`, `user_stderr`, `error`, and `wall_time_ms`.
`index` starts at zero and follows the plan order.
`actual` is the reported JSON value. `error` is `null` or an error message of at most 2,000 characters.
`wall_time_ms` is a nonnegative integer, at most 9,999,999.

Output has the limits stated above. The function supplies test inputs and expected results from the plan.
The caller cannot supply a `passed` flag, different expected results, or a different account ID.

The return value is a test run when `submitted` is `false`.
When `submitted` is `true`, the return value contains completion status, the test run, a message, and optional follow-up questions.

The test run includes each plan case, the total count, the passed count, and `all_passed`.
A case passes only if its reported value equals the expected JSON value and its error is `null`.
The total count includes error cases. Those cases do not increase the passed count.
The two result types identify their source as `local_report` and their verification as `not_server_verified`.

Malformed data, incorrect case counts, and changed retries cause errors.
The function creates no report for those requests. Saved reports do not change.
The function does not change completion status after a failed submission.

`completed` identifies the result of this submission, not a submission before this request.
A failed submission returns `completed: false`. It does not reopen a completed attempt.

The report protocol uses JSON equality. It distinguishes Boolean values from numbers.
These report rules do not change the local Python engine's comparison rules.

## Authentication and request limits

The function sends each bearer token to the Supabase user endpoint for verification.
It does not use a decoded token as proof of identity.
It rejects anonymous accounts and service-role identities.
An authentication service error returns HTTP 503 without provider error data.
An invalid token returns HTTP 401.

The function accepts POST requests with bodies of at most 1,000,000 bytes.
It rejects browser requests that contain an `Origin` header.
Browser access is not necessary for desktop and editor clients.
Responses have `Cache-Control: no-store`.

The function uses the environment variables `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
Do not put account tokens or service-role keys in source files.
The function verifies account tokens itself.
It does not use the gateway's JSON Web Token (JWT) check.
Thus, `verify_jwt` is `false` in the function configuration.
Unauthenticated clients cannot execute tools.

## Local checks

With Deno installed, enter these commands from `supabase`:

```bash
deno task check
deno task test
deno task format:check
deno task lint
```

The tests use a local HTTP server and the MCP client library.
They examine request limits, token verification, identity isolation, and error responses.
They use test responses for the Supabase authentication endpoint.
They do not show that remote account registration operates correctly.

From the repository root, examine catalog parity:

```bash
uv run python -m tools.cloud_catalog --check
```

The catalog contains only the five public coding examples and five built-in design briefs.
The generator uses the Python engine's content revisions and scaffold builder.
It does not read a private authoring repository.
Do not change an applied migration to publish new content.
Create a new migration for a subsequent catalog release.

With Docker available, execute the database contracts:

```bash
docker pull postgres:17-alpine
INTERVIEW_TEST_CLOUD_POSTGRES=1 uv run pytest -q tests/test_cloud_store.py
```

This test creates a disposable PostgreSQL container without a host port or external network access.
It uses test account records, not accounts from Supabase Auth.
It examines ownership, row policies, content revisions, concurrent saves, and immutable evidence.
The test removes its container and temporary database after completion.

The [cloud CI workflow](../.github/workflows/supabase.yml) executes these checks without production credentials.

## Deployment

The selected Free project has the `interview-mcp` function and practice migrations.
No new project, VPS, or paid model is necessary.
The function URL has this form:

```text
https://<project-ref>.supabase.co/functions/v1/interview-mcp
```

The repository migration versions are the same as the recorded remote versions.
After Supabase CLI authentication, link the selected project:

```bash
supabase link --project-ref <project-ref>
supabase db push --dry-run
```

Examine the proposed changes before database deployment.
For a new project, apply the migrations before the function deployment:

```bash
supabase db push
supabase functions deploy interview-mcp
```

Do not run `supabase config push` to change unrelated project authentication settings.
An account session token is necessary for MCP requests.
The Supabase management sign-in is not an app account token.
Do not send management credentials to the app function.

## Work before general use

The Python engine cannot run in a Supabase Edge Function without changes.
Edge Functions use TypeScript and Deno.
Local SQLite records must stay available without an account.

A configured sign-in client and end-to-end tests are necessary for account registration and automatic token refresh.
Rate limits, account storage limits, data exports, and recovery procedures are also necessary before public access.

The Supabase security advisor identifies two permission conditions in this preview:

- `iwb_content` has row-level security without a read policy. App accounts must not read subsequent hints directly.
- Authenticated accounts can execute the `SECURITY DEFINER` function `iwb_practice`.

That database function operates with its owner's permissions.
Thus, its account checks are mandatory with row-level security on the tables.
Its access controls include a specified schema path, argument validation, permission grants, and ownership tests.
A security review is necessary before public access.

The Edge Function must not execute user code.

See the [public release plan](public-release-plan.md) for account registration, payment, and distribution proposals.
See [Supabase MCP guidance](https://supabase.com/docs/guides/ai-tools/byo-mcp) for the Edge Function transport.
See [function limits](https://supabase.com/docs/guides/functions/limits) before remote practice deployment.
