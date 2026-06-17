# Dofek ML Agent Guide

> Read [README.md](./README.md) first for general architecture and usage.

## BullMQ Worker Implementation
The worker (`dofek_ml/worker.py`) owns the `training-export` queue, but the old
Postgres-backed `metric_stream` export path is retired because
`fitness.metric_stream` no longer exists.
- **Queue**: `training-export`
- **Locking**: 10m duration (`600_000ms`), 5m stalled interval.
- **Concurrency**: 1 job at a time per worker instance.
- **Current behavior**: Fails jobs explicitly with the retirement message from
  `dofek_ml/export.py`.

## Data Export Flow
Use the Redpanda R2 archive or ClickHouse metric-stream data for any future ML
training export implementation. Do not reintroduce reads from Postgres
`fitness.metric_stream`.

## Testing
- **Contract Validation**: `tests/test_contract_validation.py` ensures the export schema matches the main application expectations.
- **Worker Tests**: `tests/test_worker.py` mocks Redis and BullMQ to verify the job handling loop.
