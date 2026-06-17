"""worker.py -- BullMQ worker that processes training export jobs.

Connects directly to Redis and listens on the "training-export" queue.
When a job arrives, it fails explicitly because the Postgres-backed training
export has been retired.

This replaces the previous architecture where a Node.js BullMQ worker
spawned Python as a child process and parsed JSON lines from stdout.

Usage:
    REDIS_URL=redis://localhost:6379 python -m dofek_ml.worker
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from typing import Any
from urllib.parse import urlparse

from bullmq import Job, Worker

from dofek_ml.export import POSTGRES_METRIC_STREAM_EXPORT_RETIRED_MESSAGE

logger = logging.getLogger("dofek_ml.worker")

# Lock and stall settings for the training-export queue
LOCK_DURATION_MS = 600_000  # 10 minutes
STALLED_INTERVAL_MS = 300_000  # 5 minutes (LOCK_DURATION / 2)
MAX_STALLED_COUNT = 3

# Keep the dedicated training export worker alive by default.
# A value <= 0 disables idle shutdown.
IDLE_TIMEOUT_SECONDS = 0

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


async def process_training_export(job: Job, _token: str) -> dict[str, Any]:
    """Process a single training export job.

    The Postgres-backed export path was retired with fitness.metric_stream.
    """
    data = job.data or {}
    since = data.get("since")
    until = data.get("until")

    logger.info(
        "Rejecting retired Postgres training data export (since=%s, until=%s)",
        since or "all",
        until or "now",
    )
    raise RuntimeError(POSTGRES_METRIC_STREAM_EXPORT_RETIRED_MESSAGE)


async def run_worker() -> None:
    """Start the BullMQ worker and wait for shutdown."""
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    connection = parse_redis_url(redis_url)

    shutdown_event = asyncio.Event()
    idle_handle: asyncio.TimerHandle | None = None

    def schedule_idle_shutdown() -> None:
        nonlocal idle_handle
        if IDLE_TIMEOUT_SECONDS <= 0:
            return
        if idle_handle is not None:
            idle_handle.cancel()
        idle_handle = asyncio.get_running_loop().call_later(
            IDLE_TIMEOUT_SECONDS, lambda: shutdown_event.set()
        )

    def cancel_idle_timer() -> None:
        nonlocal idle_handle
        if idle_handle is not None:
            idle_handle.cancel()
            idle_handle = None

    def on_signal() -> None:
        logger.info("Received shutdown signal")
        cancel_idle_timer()
        shutdown_event.set()

    running_loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        running_loop.add_signal_handler(sig, on_signal)

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
    worker.on("active", lambda _job, _prev: cancel_idle_timer())
    worker.on("completed", lambda _job, _result, _prev: schedule_idle_shutdown())
    worker.on("failed", lambda _job, _error, _prev: schedule_idle_shutdown())

    if IDLE_TIMEOUT_SECONDS > 0:
        # Start idle timer immediately when idle shutdown is enabled.
        schedule_idle_shutdown()
        logger.info(
            "Training export worker started (queue=training-export, idle_timeout=%ds)",
            IDLE_TIMEOUT_SECONDS,
        )
    else:
        logger.info("Training export worker started (queue=training-export, idle_timeout=disabled)")

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
