# interview-mcp

## Setup

After cloning, activate the pre-commit hook:

```bash
git config core.hooksPath .githooks
```

This runs `./scripts/ci.sh` (lint, type check, tests, secret scan) before every commit.
