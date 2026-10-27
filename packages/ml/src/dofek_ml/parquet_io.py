"""Typed boundary wrappers for PyArrow Parquet operations."""

from __future__ import annotations

from pathlib import Path
from typing import IO

import pyarrow as pa
import pyarrow.parquet as pq

ParquetSource = str | Path | IO[bytes]


def read_schema(source: ParquetSource) -> pa.Schema:
    """Read a Parquet schema from a local path or file-like object."""
    schema: pa.Schema = pq.read_schema(source)
    return schema
