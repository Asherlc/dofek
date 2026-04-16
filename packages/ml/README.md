# Dofek ML

Machine Learning and data export pipeline for Dofek.

## Features
- **Training Export**: High-performance export of training data from TimescaleDB/Postgres to Parquet.
- **Worker**: A BullMQ worker that processes background export jobs.
- **Data Loading**: Utilities for loading exported Parquet data into Python environments.
- **Training**: Core model training logic.

## Technical Details
- **Architecture**:
  - Python-based BullMQ worker (`dofek-ml-worker`).
  - Integration with Postgres (TimescaleDB) and Redis.
  - Export to Apache Parquet format using `PyArrow` and `psycopg`.
- **Infrastructure**:
  - Containerized with a dedicated `Dockerfile`.
  - Uses `uv` for dependency management.
- **Data Model**:
  - Parquet files are organized by athlete and date range.
  - Stored in a directory structure defined by `JOB_FILES_DIR`.

## Usage
The worker listens on the `training-export` BullMQ queue.
```bash
REDIS_URL=redis://localhost:6379 DATABASE_URL=postgres://... python -m dofek_ml.worker
```
