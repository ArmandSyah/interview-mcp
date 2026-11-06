# MCP hosting options

Reviewed: 5 November 2026.
Implementation status updated: 6 November 2026.
Status: comparison and implementation proposal. This document does not provision resources.

Keep the existing Supabase MCP and database for the first release.
Host the coaching agent separately when its local prototype passes its tests.
This approach preserves the deployed practice service and avoids an idle VPS bill.

## Existing deployment and proposed hosts

The existing Supabase Free project has the `interview-mcp` Edge Function, version 5.
It stores account-owned coding attempts and design evidence in Postgres.
It does not execute submitted code. The desktop uses local Docker for code execution.

Public signup is intentionally disabled because the user has no domain and SMTP is not configured.
Existing accounts can sign in. Automatic desktop sign-in remains a separate integration.
Fresh version 5 tests passed with two real accounts, token refresh, account isolation, and cleanup.
The [deployment record](deployments/2026-11-05-supabase.md) records the verified workflows and their remaining limits.

The [local Strands lab](../experiments/strands-coach/README.md) is implemented, with an optional local AgentCore HTTP exercise.
Its latest local suite passed 49 tests, including real MCP reads and a regression for failed context reads.
These tests use scripted model responses. They create no AWS resources and make no inference calls.
The lab is separate from the desktop coach and is not a hosted service.

| Option | Idle cost | Repository fit | Main limits |
| --- | --- | --- | --- |
| Existing Supabase Edge Functions and Postgres | Free within quotas. Pro starts at $25/month. | Already deployed for the cloud practice tools. Auth and durable records share one service. | Free projects pause after one inactive week. TypeScript runtime, not the Python engine. |
| AWS Lambda Event Functions with Web Adapter | No idle execution charge without provisioned concurrency. Other services can add charges. | Proposed Python HTTP host after storage and authentication changes. | Temporary filesystem, cold starts, and a 15-minute invocation limit. |
| Google Cloud Run with request billing and minimum instances set to zero | No idle instance charge. Other services can add charges. | Proposed container host after storage and authentication changes. | Temporary filesystem, cold starts, and request timeouts. |

Sources: [Supabase pricing](https://supabase.com/pricing), [Lambda pricing](https://aws.amazon.com/lambda/pricing/), and [Cloud Run minimum instances](https://docs.cloud.google.com/run/docs/configuring/min-instances).

Supabase Free includes 500,000 function invocations, 50,000 monthly active users, a 500 MB database, and 5 GB egress.
It has no automatic database backups or uptime service-level agreement.
Pro includes two million function invocations. Additional invocations cost $2 per million.
Free is suitable for development within these limits.
Before charging customers, compare its pause and recovery limits with the service you promise.
Sources: [plan limits](https://supabase.com/pricing) and [function pricing](https://supabase.com/docs/guides/functions/pricing).

Supabase Edge Functions allow 256 MB memory and two CPU seconds per request.
The worker duration limit is 150 seconds on Free and 400 seconds on paid plans.
The request idle timeout is 150 seconds.
These limits suit short practice operations. They need careful review for long coaching loops.
Source: [Edge Function limits](https://supabase.com/docs/guides/functions/limits).

AWS Web Adapter supports Python containers and HTTP endpoints, including response streaming.
Standard Lambda Event Functions can run for at most 15 minutes.
The adapter now recommends Lambda Web Functions for new Node.js applications.
It still recommends Web Adapter for Python and other unsupported runtimes.
Sources: [Web Adapter](https://github.com/aws/aws-lambda-web-adapter) and [Lambda timeout](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html).

Cloud Run supports MCP servers that use Streamable HTTP.
Its default request timeout is five minutes. The maximum is 60 minutes.
A reconnect can reach another instance, so session state must not depend on one container.
Use request billing with zero minimum instances to avoid idle instance charges.
Sources: [MCP hosting](https://docs.cloud.google.com/run/docs/host-mcp-servers), [request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout), and [minimum instances](https://docs.cloud.google.com/run/docs/configuring/min-instances).

## Small workload estimate

These examples assume 10,000 requests per month, with one billed second per request.
They are calculations, not measured forecasts for this application.
Startup time, memory needs, and actual request duration can increase usage.

| Host configuration | Calculation before free allowances | Monthly compute and request cost |
| --- | --- | --- |
| Lambda, US East, x86, 1 GB memory | 10,000 GB-seconds × $0.0000166667, plus 10,000 requests × $0.20/million | About $0.17 |
| Cloud Run, US Central, request billing, 1 vCPU and 0.5 GiB memory | 10,000 vCPU-seconds × $0.000024, plus 5,000 GiB-seconds × $0.0000025, plus 10,000 requests × $0.40/million | About $0.26 |

The Cloud Run example assumes no savings from concurrent requests.
Lambda includes one million requests and 400,000 GB-seconds in its published monthly free allowance.
Cloud Run request billing includes two million requests, 180,000 vCPU-seconds, and 360,000 GiB-seconds at the listed region rates.
Either example can fit available free allowances, subject to account eligibility and other usage.
Sources: [Lambda pricing](https://aws.amazon.com/lambda/pricing/) and [Cloud Run pricing](https://cloud.google.com/run/pricing).

These estimates exclude databases, model tokens, network transfer, images, logs, email, domains, and payment fees.
One coaching turn can make several MCP requests.
A $10 subscription needs a measured coaching allowance. MCP request counts alone do not bound model costs.
Reusing the existing Supabase database avoids a second database service, but cross-provider requests can add latency and egress.

## Required repository changes for a Python host

The [Python entry point](../server/main.py) already serves stateless Streamable HTTP with JSON responses at `/mcp`.
The [HTTP middleware](../server/http.py) requires explicit allowed hostnames and controls browser origins.
These transport choices fit either proposed Python host.
They do not make the current database portable.

The [database configuration](../server/db/base.py) hardcodes SQLite, file backups, and `PRAGMA` schema versions.
Several repositories also use SQLite-specific insert operations.
SQLAlchemy is present, but a PostgreSQL connection URL alone would not migrate this backend.
The [Dockerfile](../Dockerfile) stores SQLite under `/data`.

Lambda provides temporary storage in `/tmp`, separately for each execution environment.
The normal Cloud Run filesystem is temporary and disappears when its instance stops.
Neither filesystem can hold durable shared practice records in an autoscaling deployment.
Sources: [Lambda storage](https://docs.aws.amazon.com/lambda/latest/dg/configuration-ephemeral-storage.html) and [Cloud Run filesystem](https://docs.cloud.google.com/run/docs/container-contract).

Choose one explicit storage approach before moving the Python service:

1. Adapt its repositories and migrations to shared Postgres.
2. Build a narrow Python MCP adapter over the existing Supabase RPC operations.

The second approach avoids duplicating the practice data model.
It supplies only the existing cloud tools. It does not add cloud queue tools or hosted code execution.
Either approach must preserve account ownership and immutable content revisions.
Local desktop records must remain available without an account. Do not upload them as an implicit migration.

The [Python authentication module](../server/auth.py) accepts repository-issued bearer keys.
It does not accept Supabase account tokens.
AWS IAM and Google IAM identities also differ from Supabase customer identities.
Retain Supabase Auth and validate its account tokens in a new application boundary if you choose another host.
A public network endpoint still needs account verification, ownership checks, and subscription checks.
See [Cloud Run MCP authentication](https://docs.cloud.google.com/run/docs/host-mcp-servers) for its separate IAM and OIDC options.

## Recommended implementation order

1. Keep Supabase as the hosted practice service.
2. Keep signup private. Complete automatic desktop sign-in before a public account launch.
3. Connect verified subscription status to hosted coaching and add usage limits.
4. Evaluate a local model through the implemented Strands lab before desktop or hosted integration.
5. Give the agent only the permitted tools and the current user identity.
6. Deploy the coach to the selected AWS runtime after its bounded prototype passes.
7. Keep submitted-code execution in the desktop Docker sandbox initially.
8. Test account isolation, expired sessions, duplicate requests, quota limits, cancellation, and cold starts.
9. Measure actual request durations and model usage before publishing an included coaching allowance.

Do not execute arbitrary submitted code in the application process that holds account or billing credentials.
The current separation between hosted practice and local execution supports this boundary.
An optional hosted execution service would require a separate design and isolation tests.

The [public release plan](public-release-plan.md) describes the earlier account and distribution proposals.
The [download website plan](download-site-plan.md) describes static hosting and installer delivery.
Those plans are proposals unless a deployment record states otherwise.
