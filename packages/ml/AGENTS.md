# Dofek ML Agent Guide

> Read [README.md](./README.md) first for general architecture and usage.

## BullMQ Worker Implementation
The worker (`dofek_ml/worker.py`) replaces the legacy Node.js child process architecture.
- **Queue**: `training-export`
- **Locking**: 10m duration (`600_000ms`), 5m stalled interval.
- **Concurrency**: 1 job at a time per worker instance.
- **Progress**: Uses `asyncio.run_coroutine_threadsafe` to report progress back to BullMQ from the synchronous export thread.

## Data Export Flow
1. Job received with `since` and `until` parameters.
2. Synchronous `export_to_parquet` runs in an executor thread.
3. Uses `psycopg` to query TimescaleDB and `PyArrow` for Parquet conversion.
4. Parquet files are written to `/tmp/dofek-job-files/training-export` (default).

## Testing
- **Contract Validation**: `tests/test_contract_validation.py` ensures the export schema matches the main application expectations.
- **Worker Tests**: `tests/test_worker.py` mocks Redis and BullMQ to verify the job handling loop.
