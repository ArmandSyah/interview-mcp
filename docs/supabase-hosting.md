# Supabase MCP preview

The Supabase Edge Function supplies a private practice preview.
It has coding catalogs, owned attempts, curated hints, and system-design tools.
It does not execute code or accept solution submissions.
The desktop app continues to use the local Python engine and SQLite database.
Existing attempts, drafts, and checkpoints do not change.

These two Model Context Protocol (MCP) tools identify the connection:

| Tool | Result |
| --- | --- |
| `ping` | Returns `pong`. |
| `get_connection_identity` | Returns the authenticated account ID, authentication issuer, and deployment status. |

The authentication issuer identifies the Supabase authentication service.
The identity result identifies one account. It contains only that account's identity.
A request without valid account credentials cannot execute tools.
The status result lists the available capabilities.
The function does not advertise unavailable execution, payment, or recall tools.

Account registration and desktop sign-in are not implemented.
A complete remote account workflow is not verified.
Use the local engine for usual desktop practice.

## Hosted records

An account can have zero or more coding attempts and design sessions.
Each attempt or design session belongs to one account.
Each record identifies one immutable content revision.
A content revision can have zero or more attempts or design sessions.
New catalog releases do not change earlier records.

A design session can have zero or more checkpoints.
Each checkpoint belongs to one session and the same account.
A checkpoint can have zero or more reviews. Each review belongs to one checkpoint.

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

## Authentication and request limits

The function sends each bearer token to the Supabase user endpoint for verification.
It does not use a decoded token as proof of identity.
It rejects anonymous accounts and service-role identities.
An authentication service error returns HTTP 503 without provider error data.
An invalid token returns HTTP 401.

The function accepts POST requests with bodies of at most 1,000,000 bytes.
It rejects browser requests that contain an `Origin` header.
The desktop and editor clients do not need browser access.
Responses have `Cache-Control: no-store`.

The function uses the environment variables `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
Do not put account tokens or service-role keys in source files.
The function verifies account tokens itself because the legacy gateway check does not support all token algorithms.
Thus, `verify_jwt` is `false` in the function configuration.
This setting does not permit unauthenticated tool access.

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
They do not prove that remote account registration works.

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
It uses test account records, not real Supabase accounts.
It examines ownership, row policies, content revisions, concurrent saves, and immutable evidence.
The test removes its container and temporary database after completion.

The [cloud CI workflow](../.github/workflows/supabase.yml) executes these checks without production credentials.

## Deployment

The selected Free project has the `interview-mcp` function and two practice migrations.
No new project, VPS, or paid model is necessary.
The function URL has this form:

```text
https://<project-ref>.supabase.co/functions/v1/interview-mcp
```

The repository migration versions are the same as the recorded remote versions.
After Supabase CLI authentication, link the intended project:

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

The Python engine cannot run unchanged in a Supabase Edge Function.
Edge Functions use TypeScript and Deno.
Local SQLite records must stay available without an account.

A stable account identity is also necessary for desktop credentials.
A token refresh must not select a different local workspace.
Account registration, token refresh, and desktop remote integration need end-to-end tests.
Rate limits, account storage limits, data exports, and recovery procedures are also necessary before public access.

The Supabase security advisor identifies two intentional permission conditions:

- `iwb_content` has row-level security without a read policy. App accounts must not read future hints directly.
- Authenticated accounts can execute the `SECURITY DEFINER` function `iwb_practice`.

That database function operates with its owner's permissions.
Thus, its account checks are mandatory, even with row-level security on the tables.
Its access controls include a defined schema path, strict arguments, permission grants, and ownership tests.
A security review is necessary before public access.

The Edge Function must not execute user code.
The desktop can use local Docker for this purpose.

See the [public release plan](public-release-plan.md) for account registration, payment, and distribution proposals.
See [Supabase MCP guidance](https://supabase.com/docs/guides/ai-tools/byo-mcp) for the Edge Function transport.
See [function limits](https://supabase.com/docs/guides/functions/limits) before remote practice deployment.
