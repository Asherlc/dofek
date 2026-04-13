"""worker.py -- BullMQ worker that processes training export jobs.

Connects directly to Redis and listens on the "training-export" queue.
When a job arrives, calls export_to_parquet() and reports progress via
BullMQ's built-in job.updateProgress().

This replaces the previous architecture where a Node.js BullMQ worker
spawned Python as a child process and parsed JSON lines from stdout.

Usage:
    REDIS_URL=redis://localhost:6379 DATABASE_URL=postgres://... \
    python -m dofek_ml.worker
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import psycopg
from bullmq import Job, Worker

from dofek_ml.export import export_to_parquet

logger = logging.getLogger("dofek_ml.worker")

# Match the Node.js worker's lock and stall settings (worker.ts:118-123)
LOCK_DURATION_MS = 600_000  # 10 minutes
STALLED_INTERVAL_MS = 300_000  # 5 minutes (LOCK_DURATION / 2)
MAX_STALLED_COUNT = 3

# Idle timeout: exit if no jobs arrive within this period (matches Node worker)
IDLE_TIMEOUT_SECONDS = 5 * 60

# Shared volume for export output (matches JOB_FILES_DIR in Node.js)
JOB_FILES_DIR = os.environ.get("JOB_FILES_DIR", "/tmp/dofek-job-files")
TRAINING_EXPORT_DIR = os.path.join(JOB_FILES_DIR, "training-export")


def parse_redis_url(url: str) -> dict[str, Any]:
    """Parse a redis:// URL into a connection dict for BullMQ Python."""
    parsed = urlparse(url)
    connection: dict[str, Any] = {
        "host": parsed.hostname or "localhost",
        "port": parsed.port or 6379,
    }
    if parsed.password:
        connection["password"] = parsed.password
    return connection


async def process_training_export(job: Job, token: str) -> dict[str, Any]:
    """Process a single training export job.

    Reads since/until from job.data, connects to Postgres, exports to Parquet,
    and reports progress via BullMQ's job.updateProgress().
    """
    data = job.data or {}
    since = data.get("since")
    until = data.get("until")

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL environment variable is required for training export")

    logger.info(
        "Starting training data export (since=%s, until=%s)",
        since or "all",
        until or "now",
    )

    async def report_progress(info: dict[str, Any]) -> None:
        await job.updateProgress(info)

    # export_to_parquet is synchronous (uses psycopg sync API + PyArrow),
    # so run it in a thread to avoid blocking the asyncio event loop.
    def run_export() -> dict[str, Any]:
        # Use a synchronous progress callback that schedules the async update
        progress_futures: list[asyncio.Future[None]] = []
        loop = asyncio.get_event_loop()

        def sync_progress(info: dict[str, Any]) -> None:
            future = asyncio.run_coroutine_threadsafe(report_progress(info), loop)
            progress_futures.append(future)

        with psycopg.connect(database_url) as conn:
            manifest = export_to_parquet(
                conn,
                Path(TRAINING_EXPORT_DIR),
                since=since,
                until=until,
                on_progress=sync_progress,
            )

        # Wait for all pending progress updates to complete
        for future in progress_futures:
            future.result(timeout=5)

        return manifest

    loop = asyncio.get_event_loop()
    manifest = await loop.run_in_executor(None, run_export)

    logger.info("Export complete: %d total rows", manifest.get("totalRows", 0))
    return manifest


async def run_worker() -> None:
    """Start the BullMQ worker and wait for shutdown."""
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    connection = parse_redis_url(redis_url)

    shutdown_event = asyncio.Event()
    idle_handle: asyncio.TimerHandle | None = None

    def schedule_idle_shutdown() -> None:
        nonlocal idle_handle
        if idle_handle is not None:
            idle_handle.cancel()
        loop = asyncio.get_event_loop()
        idle_handle = loop.call_later(IDLE_TIMEOUT_SECONDS, lambda: shutdown_event.set())

    def cancel_idle_timer() -> None:
        nonlocal idle_handle
        if idle_handle is not None:
            idle_handle.cancel()
            idle_handle = None

    def on_signal() -> None:
        logger.info("Received shutdown signal")
        cancel_idle_timer()
        shutdown_event.set()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, on_signal)

    worker = Worker(
        "training-export",
        process_training_export,
        {
            "connection": connection,
            "lockDuration": LOCK_DURATION_MS,
            "stalledInterval": STALLED_INTERVAL_MS,
            "maxStalledCount": MAX_STALLED_COUNT,
            "concurrency": 1,
        },
    )

    # Reset idle timer when jobs start/complete
    worker.on("active", lambda _job, _prev: (cancel_idle_timer()))
    worker.on("completed", lambda _job, _result, _prev: (schedule_idle_shutdown()))
    worker.on("failed", lambda _job, _error, _prev: (schedule_idle_shutdown()))

    # Start idle timer immediately
    schedule_idle_shutdown()

    logger.info(
        "Training export worker started (queue=training-export, idle_timeout=%ds)",
        IDLE_TIMEOUT_SECONDS,
    )

    await shutdown_event.wait()

    logger.info("Shutting down worker...")
    await worker.close()
    logger.info("Worker shut down.")


def main() -> None:
    """CLI entry point for the training export worker."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
