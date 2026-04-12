"""export.py -- Export sensor_sample data from PostgreSQL to Parquet.

Streams rows via a server-side cursor and writes incrementally using
PyArrow's ParquetWriter. Progress is reported via an on_progress callback
(used by the BullMQ job wrapper) or printed as JSON lines to stdout (CLI mode).

This replaces the previous Node.js + DuckDB export pipeline, eliminating the
Postgres -> Node.js -> DuckDB -> Parquet data hop. Now it's just:
Postgres -> Python -> Parquet.

Usage as a CLI:
    python -m dofek_ml.export --database-url postgres://... --output-dir /path/to/output
    python -m dofek_ml.export --database-url postgres://... --output-dir /path/to/output \\
        --since 2026-01-01T00:00:00Z --until 2026-04-01T00:00:00Z

Usage as a module:
    from dofek_ml.export import export_to_parquet
    with psycopg.connect(database_url) as conn:
        manifest = export_to_parquet(conn, output_dir)
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import psycopg
import pyarrow as pa
import pyarrow.parquet as pq

if TYPE_CHECKING:
    from collections.abc import Callable

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BATCH_SIZE = 100_000

PARQUET_SCHEMA = pa.schema(
    [
        ("recorded_at", pa.string()),
        ("user_id", pa.string()),
        ("provider_id", pa.string()),
        ("device_id", pa.string()),
        ("source_type", pa.string()),
        ("channel", pa.string()),
        ("activity_id", pa.string()),
        ("activity_type", pa.string()),
        ("scalar", pa.float64()),
        ("vector", pa.list_(pa.float64())),
    ]
)

COLUMN_NAMES: list[str] = [field.name for field in PARQUET_SCHEMA]

# ---------------------------------------------------------------------------
# SQL query
# ---------------------------------------------------------------------------

# The base export query with a placeholder for the optional WHERE clause.
# Joins activities both by direct FK and by time overlap (LATERAL) so unlinked
# sensor data (e.g., WHOOP BLE IMU) gets correct activity labels for ML training.
_BASE_QUERY = """
SELECT
  ss.recorded_at::text AS recorded_at,
  ss.user_id::text AS user_id,
  ss.provider_id,
  ss.device_id,
  ss.source_type,
  ss.channel,
  COALESCE(ss.activity_id, a_time.id)::text AS activity_id,
  COALESCE(a_direct.activity_type, a_time.activity_type) AS activity_type,
  ss.scalar,
  ss.vector
FROM fitness.sensor_sample ss
LEFT JOIN fitness.activity a_direct ON a_direct.id = ss.activity_id
LEFT JOIN LATERAL (
  SELECT a.id, a.activity_type
  FROM fitness.activity a
  WHERE ss.activity_id IS NULL
    AND a.user_id = ss.user_id
    AND ss.recorded_at >= a.started_at
    AND ss.recorded_at <= a.ended_at
  ORDER BY a.started_at DESC
  LIMIT 1
) a_time ON TRUE
{where_clause}
ORDER BY ss.recorded_at, ss.user_id, ss.provider_id, ss.channel
"""

_COUNT_QUERY = """
SELECT COUNT(*) FROM fitness.sensor_sample ss
{where_clause}
"""


def build_where_clause(since: str | None, until: str | None) -> str:
    """Build a WHERE clause with %s placeholders for psycopg parameterized queries."""
    conditions: list[str] = []
    if since:
        conditions.append("ss.recorded_at >= %s::timestamptz")
    if until:
        conditions.append("ss.recorded_at < %s::timestamptz")
    if not conditions:
        return ""
    return "WHERE " + " AND ".join(conditions)


def build_query(since: str | None, until: str | None) -> tuple[str, list[str]]:
    """Build the full export query and its parameter list.

    Returns:
        (query_string, params) where params are the values for %s placeholders.
    """
    where_clause = build_where_clause(since, until)
    params: list[str] = []
    if since:
        params.append(since)
    if until:
        params.append(until)
    query = _BASE_QUERY.format(where_clause=where_clause)
    return query, params


def _build_count_query(since: str | None, until: str | None) -> tuple[str, list[str]]:
    """Build a COUNT query with the same time filters."""
    where_clause = build_where_clause(since, until)
    params: list[str] = []
    if since:
        params.append(since)
    if until:
        params.append(until)
    return _COUNT_QUERY.format(where_clause=where_clause), params


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


def build_manifest(
    timestamp: str,
    since: str | None,
    until: str | None,
    row_count: int,
) -> dict[str, Any]:
    """Build the export manifest (same format as the previous TS implementation)."""
    manifest: dict[str, Any] = {
        "exportedAt": timestamp,
        "since": since,
        "until": until,
        "files": [],
        "totalRows": row_count,
    }
    if row_count > 0:
        manifest["files"].append(
            {
                "path": f"sensor_sample/{timestamp}.parquet",
                "table": "sensor_sample",
                "rowCount": row_count,
            }
        )
    return manifest


# ---------------------------------------------------------------------------
# Row conversion
# ---------------------------------------------------------------------------


def rows_to_record_batch(rows: list[tuple[Any, ...]]) -> pa.RecordBatch:
    """Convert a list of row tuples into a PyArrow RecordBatch.

    Each tuple must have columns in the same order as PARQUET_SCHEMA.
    """
    if not rows:
        return pa.RecordBatch.from_pydict(
            {name: [] for name in COLUMN_NAMES}, schema=PARQUET_SCHEMA
        )

    columns: dict[str, list[Any]] = {name: [] for name in COLUMN_NAMES}
    for row in rows:
        for index, name in enumerate(COLUMN_NAMES):
            columns[name].append(row[index])

    return pa.RecordBatch.from_pydict(columns, schema=PARQUET_SCHEMA)


# ---------------------------------------------------------------------------
# Core export logic
# ---------------------------------------------------------------------------


def export_to_parquet(
    conn: psycopg.Connection[Any],
    output_dir: Path,
    since: str | None = None,
    until: str | None = None,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Export sensor_sample data from Postgres to a Parquet file.

    Uses a server-side cursor to stream rows in batches without loading the
    entire table into memory. Writes incrementally via PyArrow's ParquetWriter.

    Args:
        conn: An open psycopg connection.
        output_dir: Directory to write Parquet files and manifest.json.
        since: Optional lower bound (inclusive) for recorded_at.
        until: Optional upper bound (exclusive) for recorded_at.
        on_progress: Optional callback receiving {"percentage": int, "message": str}.

    Returns:
        The manifest dict describing what was exported.
    """
    timestamp = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    output_dir = Path(output_dir)

    def report(percentage: int, message: str) -> None:
        if on_progress:
            on_progress({"percentage": percentage, "message": message})

    report(0, "Starting training data export...")

    # Count total rows for progress reporting
    count_query, count_params = _build_count_query(since, until)
    with conn.cursor() as count_cursor:
        count_cursor.execute(count_query, count_params)
        result = count_cursor.fetchone()
        total_rows: int = result[0] if result else 0

    if total_rows == 0:
        manifest = build_manifest(timestamp, since, until, 0)
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
        report(100, "Training export complete")
        return manifest

    report(5, f"Exporting {total_rows} sensor_sample rows...")

    # Prepare output directory
    parquet_dir = output_dir / "sensor_sample"
    parquet_dir.mkdir(parents=True, exist_ok=True)
    parquet_path = parquet_dir / f"{timestamp}.parquet"

    # Stream rows via server-side cursor and write Parquet incrementally
    query, params = build_query(since, until)
    exported = 0
    writer: pq.ParquetWriter | None = None

    try:
        with conn.cursor(name="training_export") as stream_cursor:
            stream_cursor.execute(query, params)

            while True:
                rows = stream_cursor.fetchmany(BATCH_SIZE)
                if not rows:
                    break

                batch = rows_to_record_batch(rows)
                if writer is None:
                    writer = pq.ParquetWriter(str(parquet_path), PARQUET_SCHEMA)
                writer.write_batch(batch)

                exported += len(rows)
                percentage = 5 + round((exported / total_rows) * 85)
                report(percentage, f"Exporting sensor_sample: {exported}/{total_rows} rows")
    finally:
        if writer is not None:
            writer.close()

    # Write manifest
    report(95, "Writing manifest...")
    manifest = build_manifest(timestamp, since, until, exported)
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

    report(100, "Training export complete")
    return manifest


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main() -> None:
    """CLI interface for exporting training data to Parquet.

    Connects to PostgreSQL, streams sensor_sample rows, and writes Parquet.
    Progress is printed as JSON lines to stdout for consumption by the
    BullMQ job wrapper.

    Examples:
        # Full export:
        python -m dofek_ml.export \\
            --database-url postgres://health:pass@localhost:5432/health \\
            --output-dir ./training-export/

        # Time-bounded export:
        python -m dofek_ml.export \\
            --database-url postgres://health:pass@localhost:5432/health \\
            --output-dir ./training-export/ \\
            --since 2026-01-01T00:00:00Z \\
            --until 2026-04-01T00:00:00Z
    """
    parser = argparse.ArgumentParser(
        description="Export sensor_sample data from PostgreSQL to Parquet"
    )
    parser.add_argument(
        "--database-url",
        required=True,
        help="PostgreSQL connection URL (e.g., postgres://user:pass@host:5432/db)",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory to write Parquet files and manifest.json",
    )
    parser.add_argument(
        "--since",
        default=None,
        help="Only export data after this timestamp (ISO 8601)",
    )
    parser.add_argument(
        "--until",
        default=None,
        help="Only export data before this timestamp (ISO 8601)",
    )
    args = parser.parse_args()

    def print_progress(info: dict[str, Any]) -> None:
        print(json.dumps(info), flush=True)

    with psycopg.connect(args.database_url) as conn:
        export_to_parquet(
            conn,
            Path(args.output_dir),
            since=args.since,
            until=args.until,
            on_progress=print_progress,
        )


if __name__ == "__main__":
    main()
