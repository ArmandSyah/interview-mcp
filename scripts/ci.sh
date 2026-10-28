#!/usr/bin/env bash
set -euo pipefail

uv sync --frozen --all-extras --dev --group authoring
uv run ruff check .
uv run ruff format --check .
uv run mypy server tools
uv run pytest -v
gitleaks detect --source .
