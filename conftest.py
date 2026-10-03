"""Keep test collection away from the operator's persistent practice database."""

import os
import tempfile

os.environ.setdefault("INTERVIEW_MCP_DB_DIR", tempfile.mkdtemp(prefix="interview-mcp-tests-"))
