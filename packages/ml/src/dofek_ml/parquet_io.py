"""Typed boundary wrappers for PyArrow Parquet operations."""

from __future__ import annotations

from pathlib import Path
from typing import IO

import pyarrow as pa
import pyarrow.parquet as pq

ParquetSource = str | Path | IO[bytes]
ParquetDestination = str | Path | IO[bytes]


def read_schema(source: ParquetSource) -> pa.Schema:
    """Read a Parquet schema from a local path or file-like object."""
    schema: pa.Schema = pq.read_schema(source)  # type: ignore[no-untyped-call]
    return schema


def read_table(source: ParquetSource) -> pa.Table:
    """Read a Parquet table from a local path or file-like object."""
    table: pa.Table = pq.read_table(source)  # type: ignore[no-untyped-call]
    return table


def write_table(table: pa.Table, destination: ParquetDestination) -> None:
    """Write a PyArrow table to a local path or file-like object."""
    pq.write_table(table, destination)  # type: ignore[no-untyped-call]


def create_writer(destination: str | Path, schema: pa.Schema) -> pq.ParquetWriter:
    """Create a Parquet writer for streaming record batches."""
    writer: pq.ParquetWriter = pq.ParquetWriter(str(destination), schema)  # type: ignore[no-untyped-call]
    return writer


def write_batch(writer: pq.ParquetWriter, batch: pa.RecordBatch) -> None:
    """Write a record batch through a Parquet writer."""
    writer.write_batch(batch)  # type: ignore[no-untyped-call]


def close_writer(writer: pq.ParquetWriter) -> None:
    """Close a Parquet writer."""
    writer.close()  # type: ignore[no-untyped-call]
