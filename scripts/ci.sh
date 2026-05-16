#!/usr/bin/env bash
set -euo pipefail

uv sync --frozen --all-extras --dev
uv run ruff check .
uv run ruff format --check .
uv run mypy server
uv run pytest -v
gitleaks detect --source .