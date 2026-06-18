# Dofek ML

Machine Learning and data export pipeline for Dofek.

## Features
- **Training Export**: The old Postgres-backed `metric_stream` export is retired.
- **Data Loading**: Utilities for loading exported Parquet data into Python environments.
- **Training**: Core model training logic.

## Technical Details
- **Architecture**:
  - Local ML training scripts and Parquet loading utilities for R2/ClickHouse-derived datasets.
- **Infrastructure**:
  - Container image kept for local ML workflows (`packages/ml/Dockerfile`).
  - Uses `uv` for dependency management.
- **Data Model**:
  - Parquet files are organized by athlete and date range.
  - Stored in a directory structure defined by `JOB_FILES_DIR`.

## Usage
Postgres `fitness.metric_stream` training export is retired. Use the Redpanda R2
archive or ClickHouse metric-stream data for ML training datasets.

The retired CLI entrypoint still reports the migration path clearly:
```bash
dofek-export --output-dir /tmp/unused
```
