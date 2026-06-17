# Dofek ML

Machine Learning and data export pipeline for Dofek.

## Features
- **Training Export**: The old Postgres-backed `metric_stream` export is retired.
- **Worker**: A BullMQ worker that rejects retired background export jobs with a clear error.
- **Data Loading**: Utilities for loading exported Parquet data into Python environments.
- **Training**: Core model training logic.

## Technical Details
- **Architecture**:
  - Python-based BullMQ worker (`dofek-ml-worker`).
  - Integration with Redis for the queue.
  - Existing Parquet loading utilities remain for R2/ClickHouse-derived training datasets.
- **Infrastructure**:
  - Containerized with a dedicated `Dockerfile`.
  - Uses `uv` for dependency management.
- **Data Model**:
  - Parquet files are organized by athlete and date range.
  - Stored in a directory structure defined by `JOB_FILES_DIR`.

## Usage
The worker listens on the `training-export` BullMQ queue and fails jobs
explicitly because Postgres `fitness.metric_stream` has been dropped.
```bash
REDIS_URL=redis://localhost:6379 python -m dofek_ml.worker
```
