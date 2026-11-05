# Local Strands coaching lab

This optional command-line lab uses Strands, Ollama, and the existing interview MCP server.
It does not change the desktop coach or enable AI in the desktop.
No AWS account, API key, subscription, or hosted computer is required.
Your computer supplies the model memory and compute.

Strands controls the model loop and tool calls.
Ollama runs the downloaded model.
The MCP server supplies practice context from a separate local database.
The model reads that context and publishes one short hint.
The lab never calls Run, Submit, design evaluation, or a save tool.

## Install

Use Python 3.12 or later, [uv](https://docs.astral.sh/uv/getting-started/installation/), and [Ollama](https://ollama.com/download).
The repository needs its own Python environment for the existing MCP server.
The commands below assume a POSIX shell and the repository root.

```sh
uv sync --locked
cd experiments/strands-coach
uv sync --locked
uv run --locked python -m pytest -q
```

This directory has its own dependencies and lock file.
It pins Strands 1.64.0, checked on 5 November 2026.
Strands installs AWS SDK dependencies, but this example never selects Bedrock.

## Start a local model

Stop an existing Ollama service before you use this terminal command.
Keep this terminal open.

```sh
OLLAMA_NO_CLOUD=1 ollama serve
```

In a second terminal, download a model that supports tool calls.
This example uses `llama3.1:8b`.
Its download requires several gigabytes, and available memory affects speed.

```sh
ollama pull llama3.1:8b
ollama list
```

The lab requires the exact installed model name.
It checks Ollama's model list and rejects models with remote metadata.
It uses only `127.0.0.1:11434` and ignores HTTP proxy settings.
Disable cloud features on the Ollama server to prevent remote inference through a model alias.
See the [official Ollama setting](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features).

## Create separate demo data

From this lab directory, run the helper with the repository's Python interpreter.
The helper creates one coding attempt and one design checkpoint.
It refuses an existing database.

```sh
../../.venv/bin/python prepare_demo.py --repo ../.. --db-dir demo-data > demo-ids.json
cat demo-ids.json
```

Use the printed identifiers in the commands below.
Each identifier belongs to this demo database.
Existing desktop or cloud identifiers will not match these records.

```sh
uv run --locked python coach.py --repo ../.. --server-python ../../.venv/bin/python \
  --db-dir demo-data --attempt-id YOUR_ATTEMPT_ID --model llama3.1:8b \
  --prompt 'Give me one conceptual hint. I am unsure what state to retain.' --trace

uv run --locked python coach.py --repo ../.. --server-python ../../.venv/bin/python \
  --db-dir demo-data --session-id YOUR_SESSION_ID --checkpoint-id YOUR_CHECKPOINT_ID \
  --model llama3.1:8b --prompt 'Which assumption should I explain next?' --trace
```

The expected result is one paragraph on standard output.
If a limit or validation check prevents a hint, the command returns an error.
The model must call the tools correctly. Some local models will fail this requirement.
The lab discards ordinary assistant text rather than display an unchecked fallback response.

On Windows, use the repository interpreter at `..\..\.venv\Scripts\python.exe`.
Run each command on one line in PowerShell.
Set `$env:OLLAMA_NO_CLOUD = "1"` before `ollama serve`.
The tests have not verified this lab on Windows.

## Boundaries

- Model input cannot choose an owner, attempt, session, checkpoint, server command, or tool name for MCP dispatch.
- Coding reads only `get_problem_description` for the supplied attempt.
- Design reads only `get_design_brief` and `get_design_snapshot` for the supplied session and checkpoint.
- The lab caches successful context within one turn. It makes at most two MCP reads.
- Strands permits at most four model calls and four admitted tool calls per turn.
- Denied calls stop the turn. Remaining calls in that batch do not execute.
- Ollama receives a limit of 512 output tokens per model call. SDK retries are disabled.
- Each MCP read has a 15-second timeout. The agent turn has a 120-second timeout.
- Prompts have an 8,000-character limit. Context has a 20,000-character limit.
- One `publish_hint` result reaches the user. It contains at most 600 characters and no newline or code fence.
- The one-result limit does not prove that the model gives only one idea or avoids a complete solution.
- Ctrl+C cancels the caller. The MCP client receives the agent cancellation signal and closes on exit.
- Cancellation prevents later dispatch. Tests cannot prove when a real model stops GPU work after disconnect.
- `--trace` writes counts and outcomes to standard error. It excludes identifiers, prompt text, evidence, and hint text.

Local stdio uses the existing server's local identity.
It does not test Supabase authentication or separate hosted accounts.
Server startup can seed or migrate its selected database, even though the agent's tool calls only read data.
Use the separate demo database for this lab.
The helper creates sample records, while the coach only reads those records.

`get_hint` is intentionally absent because it records an event and can invoke a configured model.
The desktop keeps its current hint, execution, and submission controls.
Any future submission tool must pass through the desktop's explicit submission approval.

## Tests and limits

The deterministic tests use the installed Strands SDK with a scripted model.
They test fixed identifiers, denied tools, call limits, invalid evidence, hint publication, timeout, and cancellation.
They require no Ollama service and make no model requests.
They do not measure model quality, prompt injection resistance, or hardware performance.
To test real stdio reads, supply the repository interpreter.
This test creates a temporary database and uses a scripted model.

```sh
INTERVIEW_SERVER_PYTHON="$(pwd)/../../.venv/bin/python" uv run --locked python -m pytest -q
```

## Optional AgentCore contract exercise

[The local AgentCore exercise](AGENTCORE.md) adds `/ping` and `/invocations` through the real AgentCore Python SDK.
It reuses the bounded Strands loop and connects to the same local MCP server.
It requires a local bearer credential and one fixed runtime session.
Requests cannot choose a model, MCP address, owner, or practice identifier.
Its smoke tests need no Ollama service, AWS account, or model download.

This exercise is not a deployable hosted service.
The local credential identifies the local operator. It does not verify a Supabase account.
Before hosted use, implement these requirements:

- Verify each Supabase access token and propagate it to one configured HTTPS MCP endpoint.
- Bind runtime sessions to verified accounts and owned practice identifiers outside model input.
- Check subscription access and reserve a usage allowance before each model turn.
- Configure AgentCore JWT verification, or restrict IAM invocation to a backend that performs those checks.
- Keep tokens out of model context and traces. Retain the tool allowlist and submission approval boundary.
- Select a hosted model, region, price limit, and cancellation path. Local Ollama is not available inside an AWS runtime.
- Test real token expiry, cross-account requests, disconnects, costs, and cleanup before deployment.

AgentCore and Lambda hosting require an AWS account and a separate cost decision.
See [coaching deployment options](../../docs/coaching-agent-options.md).

## SDK references

- [Ollama model provider](https://strandsagents.com/docs/user-guide/sdk/model-providers/ollama/)
- [MCP client](https://strandsagents.com/docs/user-guide/sdk/tools/mcp-tools/)
- [Hooks and events](https://strandsagents.com/docs/user-guide/sdk/agents/hooks-events/)
- [Strands Python SDK](https://github.com/strands-agents/sdk-python)
