"""Create isolated demo records. Run with the repository's Python environment."""

import argparse
import json
import os
import sys
from pathlib import Path
from uuid import uuid4


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--db-dir", type=Path, required=True)
    args = parser.parse_args()
    if (args.db_dir / "interview_mcp.sqlite").exists():
        parser.error("Choose a new demo directory. This command does not change existing data.")
    os.environ.update(
        {
            "INTERVIEW_MCP_DB_DIR": str(args.db_dir.resolve()),
            "INTERVIEW_MCP_MODE": "local",
            "PYTHON_DOTENV_DISABLED": "1",
            "LLM_PROVIDER": "fallback",
        }
    )
    sys.path.insert(0, str(args.repo.resolve()))
    from server.db import repo
    from server.design import catalog
    from server.design import repo as design_repo
    from server.main import on_startup

    on_startup()
    attempt = repo.create_attempt(repo.list_problems()[0].id, "python")
    design = design_repo.start(catalog.summaries()[0].id)
    checkpoint = design_repo.save_checkpoint(
        design.id,
        str(uuid4()),
        "0" * 64,
        {
            "requirements": "Users create short aliases. Visitors follow aliases to destination URLs."
        },
        [],
        "Strands lab sample",
    )
    print(
        json.dumps(
            {
                "attempt_id": attempt.id,
                "session_id": design.id,
                "checkpoint_id": checkpoint.id,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
