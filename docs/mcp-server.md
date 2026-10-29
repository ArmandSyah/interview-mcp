# MCP server setup

The desktop app starts the MCP engine automatically.
Use this guide only for a different MCP client or an optional HTTP server.
A hosted server is not necessary for the desktop app.

## VS Code

Install the Python dependencies before you start the server:

```bash
uv sync --frozen --dev --python 3.12
```

Open the repository root in VS Code.
For WSL, open the folder with the WSL extension.
The [workspace configuration](../.vscode/mcp.json) starts the engine with uv.

1. Open **MCP: List Servers** from the Command Palette.
2. Select **interview**.
3. Start the server.
4. Select **Show Output** if startup fails.

In the agent chat, tell the agent to get a problem list with `list_problems`.
Open the tool result to see the returned catalog.
The editor must have an enabled agent and a model provider.
The editor's model provider can collect payments for chat requests.
The MCP engine uses curated hints without model calls.

The configuration starts `server.desktop` with stdio.
That entry point uses `remote` mode to return scaffold files as data.
It does not start an HTTP server or change solution files.
Create the returned scaffold in your practice folder before you edit it.
The database stays in `.interview-mcp-vscode`, which Git ignores.
Desktop practice uses a different database.

Use the desktop app for the built-in whiteboard.
This repository does not supply a VS Code whiteboard extension.
The desktop coach limits do not control the editor's agent.
Set tool permissions in the editor.
See the [VS Code configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) for configuration fields.

## Local stdio connection

Install uv and Python 3.12. Enter these commands from the repository root:

```bash
uv sync --frozen --dev --python 3.12
```

Use this configuration in an MCP client that accepts stdio connections.
Replace the example path with the absolute path to your checkout.

```json
{
  "mcpServers": {
    "interview": {
      "command": "uv",
      "args": [
        "--directory",
        "/absolute/path/to/interview-mcp",
        "run",
        "--frozen",
        "python",
        "-m",
        "server.desktop"
      ],
      "env": {"LLM_PROVIDER": "fallback"}
    }
  }
}
```

The client sends messages to stdin and receives messages from stdout.
If you start `uv run python -m server.desktop` directly, it waits for MCP messages.
It does not open an app window.

This configuration returns a solution scaffold as data. It does not change solution files.
The optional `server.main` entry point can write scaffolds when `INTERVIEW_MCP_MODE` is `local`.
Call `list_problems`, then `start_problem`.
Use the returned attempt ID with `get_hint`, `run_tests`, and `submit_solution`.
The [local sandbox](../apps/desktop/README.md#enable-code-execution) is necessary for code execution.

## Local HTTP test stack

The HTTP mode uses a bearer key to identify each user ID.
Each user ID has isolated attempts and progress records.
It has no interactive OAuth sign-in.

Use a trusted Docker host. A privileged container is necessary for Piston.
Enter these commands from the repository root:

```bash
docker compose -f compose.remote.yml up -d --build --wait
docker compose -f compose.remote.yml exec -T server python -c "import httpx; r=httpx.post('http://piston:2000/api/v2/packages', json={'language':'python','version':'3.12.0'}, timeout=300); r.raise_for_status()"
docker compose -f compose.remote.yml exec server python -m server.auth create-key demo-user
```

Keep the printed key private. Do not add it to a source file or screenshot.
For the smoke check, set `INTERVIEW_MCP_API_KEY` in your shell.
Then enter this command:

```bash
uv run python scripts/smoke_remote.py --url http://127.0.0.1:8000/mcp --expected-problems 5
```

Stop the stack when you finish:

```bash
docker compose -f compose.remote.yml down
```

Without Docker, start only the HTTP engine with `uv run python -m server.main --remote`.
Its default address is `127.0.0.1:8000`. A Piston instance is necessary for code execution.

Remote mode returns scaffold contents as data. It does not write solution files on a user's computer.
The client must create the scaffold from `files_to_create`.
Requests must use a permitted Host header. Browser clients must also use a permitted Origin.
The server limits request size, request rate, and concurrent tools with large workloads.

`/health` returns the server status. `/ready` also returns the corpus and Python execution status.

## Storage and content

The default corpus contains five public coding examples in `problems/examples`.
The default database directory is `~/.interview-mcp`.

Set `INTERVIEW_MCP_DB_DIR` to use a different database directory.
Set `INTERVIEW_MCP_PROBLEMS_DIR` to use an accepted runtime JSON export.
Do not select an authoring repository.

The desktop app uses a different data directory and a different SQLite database.
It does not share the default stdio database automatically.
The active catalog does not include removed questions. Historical attempts keep their content snapshots.

## Optional hosting

The [Supabase preview](supabase-hosting.md) has an authenticated HTTPS endpoint.
It has no desktop sign-in or hosted code execution.
Use its guide for the deployed tools and remaining work.

The Python HTTP server is an alternative for a trusted Docker host.
HTTPS, user keys, Host restrictions, backups, and a security inspection are necessary before a public deployment.
Use one server replica with SQLite.
Do not make the Piston port available to internet clients.

The [remote CI workflow](../.github/workflows/remote.yml) includes HTTP and Piston tests.
The [image workflow](../.github/workflows/image.yml) builds the container image.
An HTTPS endpoint smoke test is mandatory before [registry publication](../.github/workflows/registry.yml).

## Design session recovery

A design session contains one attempt at a system-design brief in your local workspace or remote account.
Its backend record contains the status and completion time.
The desktop also keeps local notes, a diagram, reviews, and chat for that session.
A local workspace or remote account can have no design sessions.

`get_design_session(session_id)` reads one session for your local workspace or remote account.
`session_id` is the UUID of the session. UUID means universally unique identifier.

The result type stays `DesignSessionRead`.
The tool returns `id`, `problem_id`, `brief`, `status`, `started_at`, and `completed_at`.
`brief` contains the saved requirements and rubric for the attempt, without hints.
`status` is `in_progress` or `completed`. `completed_at` is null before completion.

The tool returns `Design session not found.` for a missing session or a session from a different local workspace or remote account.

This read changes no backend records.
The desktop reads the status before it lets the user change a saved design draft.
It examines the session ID and problem ID in the result before it uses the result.
It saves the status and completion time locally.
It keeps the notes, diagram, review, chat, and checkpoint references.

If the read or save has an error, the draft stays locked.
**Retry canvas load** does the recovery read again.

Finish waits for previous draft reads and writes.
If a previous write changes the draft, a review of the previous draft cannot complete the session.
Subsequent writes wait for Finish. They cannot change a completed session.

If the desktop does not get a correct completion response, it reads the session status again.
The desktop completes this read and the local save before it lets the user change the draft.

For correct Finish requests, the server keeps the completion time that it saved first.
SQLite and Supabase keep this time when requests occur at the same time.
The server uses the same checkpoint ownership and review requirements for each request.

No new fields are necessary for previous records.
Previous completion times keep their saved values.
The desktop does not restore completion times that previous server versions replaced.

A server without `get_design_session` cannot unlock a saved design draft in this app version.
The error tells the user to update the server.

Before clients use this version with Supabase, apply the new migration.
Before clients use this version, deploy the function.
The new migration changes the private practice function.
The migration does not change the public function for local execution reports.
