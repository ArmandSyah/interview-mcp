# Security model

## Modes

The server supports two execution modes:

- `local`: stdio MCP server launched by the user's IDE on their machine.
- `remote`: hosted MCP server reached over the network.

Local mode may write `solution.py` into the user's current working directory as
a convenience. Remote mode never writes to the user's filesystem; it returns
scaffold files as data (`relative_path`, `contents`, `sha256`) for the local
client or user to materialize.

In both modes, test execution and submission receive solution code as a string
argument. The server does not read the user's solution file from disk.

## What is sandboxed

User code submitted through test execution and submission will run inside a
Piston container with:

- 5-second wall-clock limit
- 256 MB memory cap
- isolated filesystem
- no access to the MCP server's files

The MCP server itself must never execute user-supplied code.

## What is not sandboxed

Problem descriptions are returned as strings through the MCP tool channel
(`get_problem_description(attempt_id)`). They are not written to disk as prose
files. However, any text that enters an AI agent's context window is a
potential indirect prompt injection surface.

Mitigations in place:

- `start_problem()` writes only `solution.py` in local mode.
- Remote mode writes no files and returns scaffold artifacts as data.
- The `solution.py` header is plain ASCII and intentionally short.
- The full description is never written to disk as `problem.md`.
- Problem IDs are validated against a strict regex and path-traversal checked
  before any local file write.
- Test execution and submission use explicit `attempt_id` and `code` arguments.

## Trust model summary

| Surface | Sandboxed? | Notes |
|---|---|---|
| User solution code | Yes, via Piston | Server never execs user code directly |
| Problem descriptions | No, agent context | Returned through MCP, not written as files |
| Local scaffold write | Local mode only | Convenience, not authoritative state |
| Remote scaffold artifact | Data only | Includes SHA-256 for verification |
| MCP server process | No | Runs locally or on your VPS |
| Piston service | Internal-only | Do not expose publicly |

## Remote deployment note

In remote mode, Piston should be reachable only by the MCP server over an
internal network, for example `PISTON_BASE_URL=http://piston:2000`. Do not
publish the Piston API to the internet.
