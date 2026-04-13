# Training export worker — standalone Python container.
# Consumes "training-export" jobs from BullMQ/Redis and writes Parquet files.
#
# Build:
#   docker build -t dofek-ml:local packages/ml
#
# Run:
#   docker run -e REDIS_URL=redis://redis:6379 -e DATABASE_URL=postgres://... dofek-ml:local

FROM python:3.12-slim AS base

# libpq for psycopg native driver
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies (without training extras like torch/sklearn)
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN pip install --no-cache-dir .

# Create non-root user
RUN groupadd --gid 1000 appuser && \
    useradd --uid 1000 --gid appuser --create-home appuser && \
    mkdir -p /app/job-files && chown appuser:appuser /app/job-files

USER appuser

ENTRYPOINT ["python", "-m", "dofek_ml.worker"]
