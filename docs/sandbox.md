# Local sandbox setup

Piston executes user code in a Docker container.
The Python MCP server sends code to Piston with HTTP requests.
It does not execute user code with host Python, `exec`, `eval`, or a local subprocess.

The desktop app has optional sandbox setup and automatic control of its own container.
See the [desktop guide](../apps/desktop/README.md#enable-code-execution) for that procedure.
The instructions below use the manual server development project, not the app-owned project.
The app does not stop this manual container.

CAUTION: Use this privileged container only on a trusted workstation or an isolated Docker virtual machine.
Privileged software can change host files. This can cause data loss.
Do not use a shared production host.
Do not make the Piston port available to internet clients.

## First-time local setup

Start Docker before this procedure.
Enter these commands from the repository root in your WSL shell:

```bash
docker compose up -d --wait --wait-timeout 180 piston

docker compose ps piston

curl --fail --max-time 300 http://127.0.0.1:2000/api/v2/packages \
  -H "Content-Type: application/json" \
  -d '{"language":"python","version":"3.12.0"}'

curl --fail http://127.0.0.1:2000/api/v2/runtimes

curl --fail --max-time 30 http://127.0.0.1:2000/api/v2/execute \
  -H "Content-Type: application/json" \
  -d '{
    "language": "python",
    "version": "3.12.0",
    "files": [{"content": "print(1 + 1)"}]
  }'
```

The expected JSON result contains `run.stdout: "2\n"`.
The named Docker volume keeps the installed runtime after container shutdown.

The API container uses `privileged: true`, `/piston/packages` for runtimes, and an executable tmpfs at `/tmp`.
The host port binds only to `127.0.0.1:2000`.

## Daily local operation

| Operation | Command | Effect |
| --- | --- | --- |
| Start | `docker compose up -d piston` | Starts the manual container. |
| Stop | `docker compose stop piston` | Stops the container and keeps the installed runtimes. |
| Logs | `docker compose logs -f piston` | Displays container logs until you cancel the command. |
| Restart | `docker compose restart piston` | Restarts the container and keeps the installed runtimes. |

## Remote connections

For the optional Python HTTP server, `PISTON_BASE_URL` identifies its Piston endpoint.
The [local HTTP test stack](mcp-server.md#local-http-test-stack) uses an internal container URL.
Do not publish that internal Piston port.
Only the MCP server can receive external client requests.

The [Supabase preview](supabase-hosting.md) does not host Piston or execute user code.
Its desktop client uses local Docker execution, not a public execution server.

## Troubleshooting

| Problem | Procedure |
| --- | --- |
| `Connection refused` | Enter `docker compose ps piston`. Make sure that the container reports `healthy`. |
| Python is not installed. | Enter the runtime installation command again. It does not create a duplicate runtime. |
| Piston works from PowerShell but not WSL. | Enable Docker Desktop WSL integration for your Ubuntu distribution. |
| The Python HTTP server cannot connect to Piston. | Examine `PISTON_BASE_URL` and the container network configuration. |
