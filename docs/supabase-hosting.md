# Supabase MCP preparation

The Supabase code is a connection test. It is not the remote practice engine.
The desktop app continues to use the local Python engine and SQLite database.
Existing attempts, drafts, and checkpoints do not change.

The connection test has two Model Context Protocol (MCP) tools:

| Tool | Result |
| --- | --- |
| `ping` | Returns `pong`. |
| `get_connection_identity` | Returns the authenticated account ID, authentication issuer, and deployment status. |

The authentication issuer identifies the Supabase authentication service.
Each result identifies one account. The tools return only that account's identity.
A request without valid account credentials cannot execute either tool.
The status result states that practice tools and hosted code execution are not available.

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
They do not prove that a remote deployment or account registration works.

## Work before remote practice

The Python engine cannot run unchanged in a Supabase Edge Function.
Edge Functions use TypeScript and Deno.
The remote adapter must implement the practice contracts before the desktop can use it for practice.

Account ownership and PostgreSQL row-level security are necessary for remote records.
Each attempt must keep its content revision.
Each design checkpoint and review must keep its saved evidence.
Local SQLite records must stay available without an account.

A stable account identity is also necessary for desktop credentials.
A token refresh must not select a different local workspace.
Account registration, token refresh, and desktop remote practice are not implemented in this connection test.

The Edge Function must not execute user code.
The desktop can use local Docker for this purpose.
No paid server or new Supabase project is necessary for the current preparation.

See the [public release plan](public-release-plan.md) for account registration, payment, and distribution proposals.
See [Supabase MCP guidance](https://supabase.com/docs/guides/ai-tools/byo-mcp) for the Edge Function transport.
See [function limits](https://supabase.com/docs/guides/functions/limits) before remote practice deployment.
