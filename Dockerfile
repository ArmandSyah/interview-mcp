FROM ghcr.io/astral-sh/uv:0.11.14 AS uv

FROM python:3.12-slim AS builder
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

FROM python:3.12-slim
RUN groupadd --gid 10001 interview && useradd --uid 10001 --gid 10001 --create-home interview \
    && mkdir /data && chown interview:interview /data
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY server ./server
COPY problems/examples ./problems/examples
ENV PATH="/app/.venv/bin:$PATH" INTERVIEW_MCP_DB_DIR=/data INTERVIEW_MCP_MODE=remote \
    INTERVIEW_MCP_HOST=0.0.0.0 LLM_PROVIDER=fallback PYTHONUNBUFFERED=1
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"
CMD ["python", "-m", "server.main", "--remote"]
