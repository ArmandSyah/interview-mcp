# Coaching agent options

Start with Python Strands and local Ollama for hands-on agent development.
This path needs no AWS account and creates no cloud bill.
The [local Strands lab](../experiments/strands-coach/README.md) is available as a separate command-line example.
AI stays off by default.

Strands supplies an agent loop, model interfaces, tools, and hooks.
AgentCore supplies optional AWS hosting and related services.
They can work together. Strands does not require AgentCore.
Python Strands supports Ollama. The current TypeScript provider list does not include a built-in Ollama provider.
See the [Strands provider list](https://strandsagents.com/docs/user-guide/sdk/model-providers/).

## Options

| Option | What it provides | Main cost or limit |
| --- | --- | --- |
| Python Strands with local Ollama | Agent-library practice on the user's computer | Local processor, memory, storage, and electricity. No cloud bill. |
| Strands on AgentCore microVM Runtime | Managed sessions, streaming, identity integration, and tracing | Runtime, model, storage, logs, and network charges. Requires AWS. |
| Strands on ordinary on-demand Lambda | A small endpoint for bounded coach requests | Invocation duration includes model waits. Streaming needs additional integration. |

The official Lambda example uses CDK and does not implement response streaming.
Ordinary Lambda functions have a maximum invocation timeout of 15 minutes.
The Lambda option here excludes provisioned concurrency and Managed Instances.
See the [Strands Lambda guide](https://strandsagents.com/docs/user-guide/sdk/deploy/deploy_to_aws_lambda/) and [Lambda timeout reference](https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html).

## Existing behavior to preserve

The current contracts are in [agent.ts](../apps/desktop/src/main/agent.ts) and [service.ts](../apps/desktop/src/main/service.ts).
The Strands adapter must preserve these limits:

- At most six model rounds and ten tool calls per user turn.
- At most one hint request per turn, with progressive hint depth.
- Coding calls use the attempt and code captured by the app.
- Design calls use the immutable checkpoint captured for that turn.
- Submission requires explicit approval through the desktop.
- The design coach cannot edit the canvas, switch sessions, or finish practice.
- Cancellation must preserve drafts and release the active operation.
- Grading stays a separate, bounded request based on captured evidence.

Tool results and practice text remain untrusted data.
Enforce tool names, arguments, and budgets in code, not only in a system prompt.
Strands hooks can inspect and reject tool calls before execution.
See [hook events](https://strandsagents.com/docs/user-guide/sdk/agents/hooks-events/).

## Local prototype

The [lab README](../experiments/strands-coach/README.md) contains installation, demo, and test commands.
The experiment has its own dependency file and lock file, with Strands 1.64.0.
It requires Python 3.12 or later and does not change desktop dependencies.

Always supply an explicit `OllamaModel` with a loopback host and an installed model ID.
Bare `Agent()` defaults to Bedrock and requires AWS credentials.
Use a local model that supports tool calls.
See the [Ollama provider](https://strandsagents.com/docs/user-guide/sdk/model-providers/ollama/) and [Strands package](https://pypi.org/project/strands-agents/).

The lab connects to the existing local MCP process through standard input and output.
Its helper creates separate demo records. Server startup can seed or migrate the selected database.
The agent reads fixed practice identifiers and cannot choose an owner or another checkpoint.
Hosted HTTP transport and account authentication remain future work.
See [MCP transports](https://strandsagents.com/docs/user-guide/sdk/tools/mcp-transports/).

The model receives only `read_context` and `publish_hint` tools.
MCP calls read the problem description or the design brief and saved checkpoint.
The existing coding `get_hint` tool is excluded because it records events and can invoke another model.
Code limits each turn to four model calls, four admitted tool calls, and one published hint.
The lab does not replace the desktop coach. Execution, submission, and saved desktop practice keep their existing controls.

The optional [AgentCore exercise](../experiments/strands-coach/AGENTCORE.md) provides local HTTP routes through SDK 1.25.3.
It requires a local bearer credential and fixed session, retains the Strands limits, and verifies cancellation through the SDK worker.
This local credential does not verify a Supabase account. The exercise is not a deployable hosted service.

Before desktop integration, evaluate real local model behavior and preserve the existing service dispatcher.
That dispatcher must retain argument binding, approval, cancellation, and result validation.
See [Strands MCP integration](https://strandsagents.com/docs/user-guide/sdk/tools/mcp-tools/).

## Optional AWS deployment

The user has no AWS account. No AWS resource is necessary for the local milestone.
Create an AWS account only when a hosted trial is selected.
Choose a region and model after a small coaching evaluation.

```text
Desktop -> authenticated coach API -> Strands on AgentCore -> owned MCP tools
```

The API verifies the app account, subscription entitlement, and usage allowance before each invocation.
It binds each runtime session to one verified account.
A runtime session can contain several coach turns from that account.
An account can have several sessions, but cannot use another account's session.
The agent must not choose an owner ID or replace the captured practice identifiers.

AgentCore supports IAM request signing and custom JWT authentication.
Direct JWT access requires verified issuer, discovery, signing-key, and audience compatibility with the login provider.
Otherwise, a trusted backend can verify the app token and invoke AgentCore with its AWS role.
Do not put AWS credentials in the desktop.
See [AgentCore authentication](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-oauth.html).

Keep durable practice in the existing database.
Runtime isolation does not replace ownership checks or durable storage.
Set deliberate session limits and stop finished sessions through `StopRuntimeSession`.
Closing a client stream does not prove that remote execution stopped.
Verify cancellation at the runtime and model boundaries.
See [runtime sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html).

Start with Runtime alone. Add Gateway or managed memory only for a demonstrated requirement.
Use redacted tracing with a short retention period.
Do not log account tokens or complete private drafts.
Check installed versions and command help before deployment.
See [AgentCore deployment](https://strandsagents.com/docs/user-guide/sdk/deploy/deploy_to_bedrock_agentcore/).

## Cost assumptions

Prices below were checked on 5 November 2026. They are USD examples before credits and tax.

| AgentCore microVM resource | v1 | v2 consumption |
| --- | --- | --- |
| CPU per vCPU-hour | $0.0895 | $0.1276 |
| Memory per GB-hour | $0.00945 | $0.0169 |

CPU usage falls to zero during I/O waits. Memory can remain billable.
Runtime v2 reclaims idle memory after 120 seconds.
Model calls, storage, logs, and network charges are additional.
Avoid committed capacity or Instances for this early trial.
See [AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/).

For illustration, assume 2,000 turns each consume two CPU-seconds and 140 billable GB-seconds, including initialization and retained memory.
AgentCore v2 compute would cost about $1.46 for that workload.
This is an assumed workload, not a measured forecast.

At one GB for 20 seconds per turn, ordinary Lambda compute and requests would cost about $0.67 before free allowances.
Its API, model, logging, and network costs are additional.
See [Lambda pricing](https://aws.amazon.com/lambda/pricing/).

Model cost depends on total input and output tokens across every model call in a turn.
Repeated history and tool results can increase input usage.
Measure token totals before choosing any included allowance for the $10 subscription.
See [Bedrock model pricing](https://aws.amazon.com/bedrock/pricing/).

## Verification milestones

1. Completed: 49 tests passed with Strands, the optional AgentCore SDK, scripted model responses, and real local MCP coding and design reads.
2. Completed: tests cover identifiers, local credentials, request validation, tool limits, hint publication, concurrency, timeout, and cancellation.
3. Evaluate a local model for useful hints, factual errors, and unwanted solution disclosure.
4. Integrate desktop events and verify existing approval and draft-preservation stories.
5. Prepare reviewed AWS infrastructure, usage caps, and cleanup commands before any hosted trial.
6. Verify live authentication, subscription checks, ownership, cancellation, and measured costs after deployment.

Ruff and lock checks passed. The lab has not been verified on Windows or with hosted account authentication.
No model inference ran during verification. No AWS resources were created, and no paid model calls were made.
