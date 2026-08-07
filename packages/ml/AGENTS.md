# Dofek ML Agent Guide

> Read [README.md](./README.md) first for general architecture and usage.

## Retired Postgres training export
The BullMQ `training-export` worker and Postgres-backed `metric_stream` export
path were removed with the Postgres table drop. Do not reintroduce reads from
Postgres `fitness.metric_stream`.

## Data Export Flow
Use the Redpanda R2 archive or ClickHouse metric-stream data for any future ML
training export implementation.

## Testing
- **Contract Validation**: `tests/test_contract_validation.py` ensures the export schema matches the main application expectations.
- **Export retirement**: `tests/test_export.py` verifies the retired CLI/export entrypoints fail with the migration message.
