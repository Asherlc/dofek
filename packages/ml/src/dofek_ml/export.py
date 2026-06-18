"""Retired Postgres metric-stream training export entrypoint."""

from __future__ import annotations

import argparse
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

POSTGRES_METRIC_STREAM_EXPORT_RETIRED_MESSAGE = (
    "Postgres metric_stream training export has been retired because "
    "fitness.metric_stream was removed from Postgres. Use the Redpanda R2 "
    "archive or ClickHouse metric-stream data for training exports."
)


def export_to_parquet(
    _conn: object,
    _output_dir: Path,
    since: str | None = None,
    until: str | None = None,
    on_progress: Callable[[dict[str, object]], None] | None = None,
) -> dict[str, object]:
    """Fail explicitly for the retired Postgres-backed training export."""
    _ = since, until, on_progress
    raise RuntimeError(POSTGRES_METRIC_STREAM_EXPORT_RETIRED_MESSAGE)


def main() -> None:
    """CLI interface retained to report the retired export path clearly."""
    parser = argparse.ArgumentParser(description="Retired Postgres metric_stream training export")
    parser.add_argument(
        "--database-url",
        default=None,
        help="Ignored; Postgres metric_stream export is retired.",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        help="Ignored; Postgres metric_stream export is retired.",
    )
    parser.add_argument(
        "--since",
        default=None,
        help="Ignored; Postgres metric_stream export is retired.",
    )
    parser.add_argument(
        "--until",
        default=None,
        help="Ignored; Postgres metric_stream export is retired.",
    )
    parser.parse_args()
    raise RuntimeError(POSTGRES_METRIC_STREAM_EXPORT_RETIRED_MESSAGE)


if __name__ == "__main__":
    main()
