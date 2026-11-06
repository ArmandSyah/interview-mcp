# Local AgentCore contract exercise

This exercise uses `bedrock-agentcore==1.25.3` with the existing Strands coaching loop.
It teaches the AgentCore HTTP entrypoint without creating AWS resources.
It does not provide a deployment configuration or a hosted authentication service.

AgentCore Runtime expects `POST /invocations` and `GET /ping`.
The SDK creates those routes through `BedrockAgentCoreApp` and `@app.entrypoint`.
This example binds to `127.0.0.1:8080` explicitly.
It never chooses Bedrock, downloads a model, or invokes AWS APIs.

## Run the contract tests

From the lab directory, install the optional SDK and run its tests.

```sh
uv sync --locked --extra agentcore
uv run --locked --extra agentcore python -m pytest -q tests/test_agentcore_local.py
```

The tests use the actual AgentCore request handler, worker loop, and Strands tool loop.
Scripted model responses and MCP results replace inference and database access in these tests.
Tests cover credentials, session binding, request fields, limits inherited from Strands, concurrency, cancellation, and error responses.
The separate `tests/test_mcp.py` test checks actual MCP reads with disposable database records.

## Run with local Ollama

First, complete the [Ollama and demo setup](README.md).
Use the same shell for the following commands.
Replace `YOUR_ATTEMPT_ID` with the coding identifier from `demo-ids.json`.

```sh
export COACH_LOCAL_TOKEN="$(uv run --locked --extra agentcore python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export COACH_LOCAL_SESSION="$(uv run --locked --extra agentcore python -c 'import uuid; print(uuid.uuid4())')"

uv run --locked --extra agentcore python agentcore_local.py \
  --repo ../.. --server-python ../../.venv/bin/python --db-dir demo-data \
  --attempt-id YOUR_ATTEMPT_ID --model llama3.1:8b &
coach_pid=$!

curl --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:8080/ping

curl --fail-with-body http://127.0.0.1:8080/invocations \
  -H "Authorization: Bearer $COACH_LOCAL_TOKEN" \
  -H "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: $COACH_LOCAL_SESSION" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Give one conceptual hint about the state I must retain."}'

kill "$coach_pid"
wait "$coach_pid"
unset COACH_LOCAL_TOKEN COACH_LOCAL_SESSION
```

For design practice, replace `--attempt-id` with `--session-id` and `--checkpoint-id` from the demo file.
The runtime session identifier differs from the design session identifier.
The first binds requests to this local process. The second selects the saved design evidence.

The successful response has this shape:

```json
{"hint":"One short model-generated hint.","mode":"local-contract-only"}
```

A request can contain only a nonblank `prompt` with at most 8,000 characters.
The credential and runtime session come from HTTP headers.
The process configuration supplies the practice identifiers, model, interpreter, repository, and database.
Those settings remain fixed for the process lifetime.
Each request creates a new Strands turn without conversation history.

## Local access and limits

The local bearer credential proves possession of the operator's configured secret.
It is not a Supabase token and does not represent a hosted account.
The runtime session header must match the configured UUID.
The model never receives the credential or selects a session.

The adapter rejects browser origins, other host headers, WebSocket requests, and extra payload fields.
It strips credentials, identity headers, and tracing baggage before the SDK receives the request.
Only the local health route works without the credential.
The adapter admits one turn at a time and rejects a concurrent turn with HTTP 409.

The request body has a 40,000-byte limit and a five-second read timeout.
The existing Strands limits remain four model calls, four admitted tool calls, and one published hint.
The agent has a 120-second timeout. Each MCP read has a 15-second timeout.
The adapter cancels the SDK invocation when the HTTP caller disconnects.
Tests verify cancellation through the SDK worker and prevent later tool calls.
They do not prove when a real Ollama process stops GPU work.

HTTP 400 means invalid prompt fields. HTTP 401 means an invalid local credential.
HTTP 403 means an invalid host, browser origin, or runtime session.
HTTP 413 means an oversized request. HTTP 415 means the request is not JSON.
HTTP 503 means no valid hint completed. HTTP 504 means the agent timeout expired.
Responses do not include provider errors or private tool evidence.

## Requirements before AWS hosting

Do not deploy this local entrypoint or expose its port through a public tunnel.
Loopback Ollama and the local stdio identity do not supply a hosted account boundary.
The [README requirements](README.md#optional-agentcore-contract-exercise) identify the missing authentication, ownership, usage, model, and cancellation work.

AgentCore supports IAM request signing and JWT authentication.
A supplied user identifier alone does not prove the caller's identity.
Choose verified JWT configuration, or restrict IAM invocation to a trusted backend that checks the app token.
Retain ownership checks in the MCP service even when AgentCore verifies the caller.

Deployment also needs an AWS account, permissions, an explicit model choice, and a reviewed cost limit.
This exercise includes no deployment command and creates no billable infrastructure.
It has not been verified on Windows or against the hosted AgentCore service.

Sources checked on 5 November 2026:

- [AgentCore Python entrypoint and local testing](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-python.html)
- [AgentCore inbound authentication](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-oauth.html)
- [Strands deployment guide](https://strandsagents.com/docs/user-guide/sdk/deploy/deploy_to_bedrock_agentcore/)
