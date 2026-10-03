# Interview MCP

Coding interview practice through MCP: browse Python problems, start an attempt,
receive progressive hints, run sandboxed tests, submit solutions, and track progress.
Supports local stdio and authenticated remote Streamable HTTP.

## Remote connection

The public hosted endpoint has not been provisioned yet. Once deployed, connect
your editor to `https://YOUR_HOST/mcp` and send your personal access key:

```json
{
  "mcpServers": {
    "interview": {
      "url": "https://YOUR_HOST/mcp",
      "headers": {"Authorization": "Bearer YOUR_PERSONAL_KEY"}
    }
  }
}
```

The operator issues a separate key/user ID to each person; attempts, active problems,
hints and progress are scoped to that user. Key-based clients such as Cursor and
Claude Code can use this connection. Clients requiring an interactive OAuth flow
need an OAuth integration before they can connect.

Call `list_problems`, then `start_problem`. Remote mode returns `files_to_create`
with the scaffold contents and checksum. Create the file in your own workspace.
Pass the returned `attempt_id` and your code to `run_tests`, `get_hint`, and
`submit_solution`. `get_progress` shows only your attempts.

## Run locally

```bash
uv sync --frozen --dev
cp .env.example .env
# Start Piston with Docker and install Python 3.12.0 as described below.
uv run python -m server.main
```

The stdio server uses your local database and can write solution scaffolds to the
working directory. Set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` for generated
hints, or `LLM_PROVIDER=fallback` for curated hints and default follow-up questions.

## Test the remote stack

```bash
docker compose -f compose.remote.yml up -d --build --wait
docker compose -f compose.remote.yml exec -T server python -c "import httpx; r=httpx.post('http://piston:2000/api/v2/packages', json={'language':'python','version':'3.12.0'}, timeout=300); r.raise_for_status()"
docker compose -f compose.remote.yml exec server python -m server.auth create-key your-user-id
# Store the printed key in your client, or export INTERVIEW_MCP_API_KEY for the smoke check.
uv run python scripts/smoke_remote.py --url http://127.0.0.1:8000/mcp --expected-problems 5
```

For HTTP without Docker: `uv run python -m server.main --remote`. The default
binding is `127.0.0.1:8000`. An ASGI host can use
`uvicorn server.http:create_app --factory --host 127.0.0.1 --port 8000`.
Both entry points initialize the database and validate/load questions in their
lifespan. Remote startup fails if the selected corpus is missing or invalid.

`/health` checks server liveness. `/ready` also checks the question corpus and
Piston Python runtime. Requests need an allowed Host, browser Origin headers need
explicit allowlisting, and MCP access requires a bearer key. The server bounds
request/code size, request volume, and concurrent expensive tools.

## Hosting and discovery

The private `interview-mcp-ops` repo contains `deploy/compose.yml`, Caddy/TLS setup,
runtime export and installation scripts, and deployment instructions. Its export
checks human acceptance and strips authoring/review metadata. Production mounts
that private export read-only and persists SQLite in a named volume. Run one server
replica with SQLite. Public engine images contain the five examples only.

GitHub Actions builds the Docker image and tests the real HTTP/Piston stack.
Version tags publish images to `ghcr.io/armandsyah/interview-mcp`.

Discovery uses the [official MCP Registry](https://registry.modelcontextprotocol.io).
It hosts server metadata and points clients at your live endpoint. After deploying
and verifying HTTPS, set `REGISTRY_SMOKE_API_KEY` to a dedicated user's key and run
the **Publish to MCP Registry** workflow on `main` with your real `/mcp` URL.
It verifies the live service, renders `registry/server.json.template`, and publishes
using GitHub OIDC. No package publication is required for a remote-only listing.
The workflow is manual and will not publish a placeholder endpoint.

Alternatively, render metadata with `scripts/make_registry_manifest.py --url ...`,
then use the official `mcp-publisher` to authenticate, validate and publish it.
See [remote server publication](https://modelcontextprotocol.io/registry/remote-servers).

## Setup

After cloning, activate the pre-commit hook:

```bash
git config core.hooksPath .githooks
```

This runs `./scripts/ci.sh` (lint, type check, tests, secret scan) before every commit.

## Problem Content

Five public examples in `problems/examples/` are the default corpus, resolved
relative to the installed server. Set `INTERVIEW_MCP_PROBLEMS_DIR` to an accepted
runtime JSON directory for a larger corpus. Never point it at a whole authoring repo.
`INTERVIEW_MCP_DB_DIR` controls persistent SQLite storage (default `~/.interview-mcp`).
Questions removed from a remote corpus are hidden from the catalog while historical
attempts remain available to their owners. `interview-problem-quality` stores the
authoring rules and validators and is not a runtime dependency.
