# Local sandbox setup

The MCP server executes user code in a [Piston](https://github.com/engineer-man/piston)
container. In local development, the server talks to Piston at
`http://localhost:2000`. In remote mode, the hosted MCP server should use an
internal service URL through `PISTON_BASE_URL`.

## First-time local setup

From the repo root, in your WSL shell:

```bash
# 1. Bring up Piston.
docker compose up -d piston

# 2. Confirm it is healthy. It may take around 15 seconds.
docker compose ps piston

# 3. Install the Python runtime once. The named Docker volume persists it.
curl -X POST http://localhost:2000/api/v2/packages \
  -H "Content-Type: application/json" \
  -d '{"language":"python","version":"3.12.0"}'

# 4. Confirm the runtime is available.
curl http://localhost:2000/api/v2/runtimes

# 5. Smoke test execution.
curl -X POST http://localhost:2000/api/v2/execute \
  -H "Content-Type: application/json" \
  -d '{
    "language": "python",
    "version": "3.12.0",
    "files": [{"content": "print(1 + 1)"}]
  }'
```

The smoke test should return JSON whose `run.stdout` is `2\n`.

## Daily local operation

- Start: `docker compose up -d piston`
- Stop: `docker compose down`
- Logs: `docker compose logs -f piston`
- Restart, keeping installed runtimes: `docker compose restart piston`
- Recreate from scratch, losing installed runtimes: `docker compose down -v`

## Why Piston runs separately

The MCP server must never execute user-submitted code directly with Python
`exec`, `eval`, or a local subprocess. Piston gives us an HTTP boundary between
the server and untrusted code execution. Later application code will send a
script to Piston and receive structured stdout, stderr, exit code, and timing
data back.

## Remote deployment shape

Remote mode should not expose Piston publicly. The production shape later should
look like this:

```yaml
services:
  server:
    image: ghcr.io/yourusername/interview-mcp:v0.2.0
    environment:
      INTERVIEW_MCP_MODE: remote
      PISTON_BASE_URL: http://piston:2000
    depends_on:
      piston:
        condition: service_healthy

  piston:
    image: ghcr.io/engineer-man/piston
    expose:
      - "2000"
    volumes:
      - piston_data:/piston
    tmpfs:
      - /tmp
```

Only the MCP server should sit behind public ingress. Piston should be reachable
from the server container and nowhere else.

## Troubleshooting

**`Connection refused` from the Python server.** Piston may still be starting.
Run `docker compose ps piston` and check for `healthy`.

**Runtime not installed.** Repeat the package install POST. The install is
idempotent.

**Piston is unreachable from WSL but works from PowerShell.** Docker Desktop's
WSL integration may be disabled for your Ubuntu distro.

**Remote server cannot reach Piston.** Check `PISTON_BASE_URL`, container DNS,
and whether both services are on the same Docker network.
