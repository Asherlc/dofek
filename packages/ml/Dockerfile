# Local ML tooling image. The production training-export BullMQ worker was retired
# with Postgres fitness.metric_stream.
#
# Build:
#   docker build -t dofek-ml:local packages/ml
#
# Run:
#   docker run dofek-ml:local dofek-export --output-dir /tmp/unused

FROM python:3.14-slim AS base

# libpq for psycopg native driver
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml uv.lock README.md ./
COPY src ./src
RUN pip install --no-cache-dir .

# Create non-root user
RUN groupadd --gid 1000 appuser && \
    useradd --uid 1000 --gid appuser --create-home appuser && \
    mkdir -p /app/job-files && chown appuser:appuser /app/job-files

USER appuser

ENTRYPOINT ["dofek-export"]
