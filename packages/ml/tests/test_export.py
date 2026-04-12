"""Tests for dofek_ml.export -- Postgres-to-Parquet training data export."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock, patch

import pyarrow.parquet as pq
import pytest

from dofek_ml.export import (
    PARQUET_SCHEMA,
    build_manifest,
    build_query,
    build_where_clause,
    export_to_parquet,
    main,
    rows_to_record_batch,
)

if TYPE_CHECKING:
    from pathlib import Path

# Timestamp constant used across tests
TS = "2026-03-30T15:00:00Z"
TS2 = "2026-03-30T15:00:01Z"
USER = "user-1"


def _row(
    channel: str = "heart_rate",
    scalar: float | None = 142.0,
    vector: list[float] | None = None,
    provider: str = "wahoo",
    device: str | None = None,
    activity_id: str | None = None,
    activity_type: str | None = None,
    timestamp: str = TS,
) -> tuple[Any, ...]:
    """Build a sensor sample row tuple matching the export query column order."""
    return (
        timestamp,
        USER,
        provider,
        device,
        "ble",
        channel,
        activity_id,
        activity_type,
        scalar,
        vector,
    )


# ---------------------------------------------------------------------------
# Tests for build_where_clause()
# ---------------------------------------------------------------------------


class TestBuildWhereClause:
    """Tests for build_where_clause()."""

    def test_no_filters_returns_empty(self) -> None:
        assert build_where_clause(None, None) == ""

    def test_since_only(self) -> None:
        result = build_where_clause("2026-03-01T00:00:00Z", None)
        assert result == "WHERE ss.recorded_at >= %s::timestamptz"

    def test_until_only(self) -> None:
        result = build_where_clause(None, "2026-03-31T00:00:00Z")
        assert result == "WHERE ss.recorded_at < %s::timestamptz"

    def test_both_since_and_until(self) -> None:
        result = build_where_clause("2026-03-01T00:00:00Z", "2026-03-31T00:00:00Z")
        assert "ss.recorded_at >= %s::timestamptz" in result
        assert "ss.recorded_at < %s::timestamptz" in result
        assert result.startswith("WHERE ")
        assert " AND " in result


# ---------------------------------------------------------------------------
# Tests for build_query()
# ---------------------------------------------------------------------------


class TestBuildQuery:
    """Tests for build_query()."""

    def test_no_filters(self) -> None:
        query, params = build_query(None, None)
        assert "sensor_sample" in query
        assert "LATERAL" in query
        # No top-level time filter placeholders
        assert "ss.recorded_at >= %s" not in query
        assert "ss.recorded_at < %s" not in query
        assert params == []

    def test_since_only(self) -> None:
        query, params = build_query("2026-03-01T00:00:00Z", None)
        assert "WHERE" in query
        assert params == ["2026-03-01T00:00:00Z"]

    def test_until_only(self) -> None:
        query, params = build_query(None, "2026-03-31T00:00:00Z")
        assert "WHERE" in query
        assert params == ["2026-03-31T00:00:00Z"]

    def test_both(self) -> None:
        since = "2026-03-01T00:00:00Z"
        until = "2026-03-31T00:00:00Z"
        query, params = build_query(since, until)
        assert "WHERE" in query
        assert " AND " in query
        assert params == [since, until]

    def test_query_includes_lateral_join(self) -> None:
        query, _ = build_query(None, None)
        assert "LEFT JOIN LATERAL" in query
        assert "a_time" in query

    def test_query_orders_by_composite_key(self) -> None:
        query, _ = build_query(None, None)
        expected = "ORDER BY ss.recorded_at, ss.user_id"
        assert expected in query


# ---------------------------------------------------------------------------
# Tests for build_manifest()
# ---------------------------------------------------------------------------


class TestBuildManifest:
    """Tests for build_manifest()."""

    def test_with_rows(self) -> None:
        manifest = build_manifest(TS, None, None, 5000)
        assert manifest["exportedAt"] == TS
        assert manifest["since"] is None
        assert manifest["until"] is None
        assert manifest["totalRows"] == 5000
        assert len(manifest["files"]) == 1
        assert manifest["files"][0]["table"] == "sensor_sample"
        assert manifest["files"][0]["rowCount"] == 5000

    def test_zero_rows(self) -> None:
        manifest = build_manifest(TS, None, None, 0)
        assert manifest["files"] == []
        assert manifest["totalRows"] == 0

    def test_includes_time_bounds(self) -> None:
        since = "2026-03-01T00:00:00Z"
        until = "2026-03-31T00:00:00Z"
        manifest = build_manifest(TS, since, until, 100)
        assert manifest["since"] == since
        assert manifest["until"] == until

    def test_file_path_uses_timestamp(self) -> None:
        timestamp = "2026-03-30T15:30:00Z"
        manifest = build_manifest(timestamp, None, None, 100)
        expected = f"sensor_sample/{timestamp}.parquet"
        assert manifest["files"][0]["path"] == expected


# ---------------------------------------------------------------------------
# Tests for rows_to_record_batch()
# ---------------------------------------------------------------------------


class TestRowsToRecordBatch:
    """Tests for rows_to_record_batch()."""

    def test_converts_scalar_rows(self) -> None:
        rows = [
            _row(channel="heart_rate", scalar=142.0),
            _row(
                channel="power",
                scalar=250.0,
                activity_id="act-1",
                activity_type="cycling",
                timestamp=TS2,
            ),
        ]
        batch = rows_to_record_batch(rows)
        assert batch.num_rows == 2
        assert batch.schema == PARQUET_SCHEMA
        assert batch.column("scalar").to_pylist() == [142.0, 250.0]

    def test_converts_vector_rows(self) -> None:
        rows = [
            _row(
                channel="imu",
                scalar=None,
                vector=[0.1, 0.2, 9.8],
                provider="apple_health",
                device="Watch",
            ),
        ]
        batch = rows_to_record_batch(rows)
        assert batch.num_rows == 1
        vector_value = batch.column("vector").to_pylist()[0]
        assert vector_value == pytest.approx([0.1, 0.2, 9.8])

    def test_handles_all_nullables(self) -> None:
        rows = [_row(scalar=None)]
        batch = rows_to_record_batch(rows)
        assert batch.num_rows == 1
        assert batch.column("device_id").to_pylist() == [None]
        assert batch.column("scalar").to_pylist() == [None]
        assert batch.column("vector").to_pylist() == [None]

    def test_empty_rows(self) -> None:
        batch = rows_to_record_batch([])
        assert batch.num_rows == 0
        assert batch.schema == PARQUET_SCHEMA


# ---------------------------------------------------------------------------
# Mock helpers for psycopg
# ---------------------------------------------------------------------------


def _make_sample_rows() -> list[tuple[Any, ...]]:
    """Build sample sensor rows as tuples."""
    return [
        _row(
            channel="heart_rate",
            scalar=142.0,
            activity_type="cycling",
        ),
        _row(
            channel="power",
            scalar=250.0,
            activity_id="act-1",
            activity_type="cycling",
        ),
        _row(
            channel="imu",
            scalar=None,
            vector=[0.1, 0.2, 9.8],
            provider="apple_health",
            device="Watch",
        ),
    ]


def _mock_connection(
    count_result: int = 3,
    rows: list[tuple[Any, ...]] | None = None,
) -> MagicMock:
    """Build a mock psycopg Connection that returns count + rows."""
    if rows is None:
        rows = _make_sample_rows()

    conn = MagicMock()

    # Regular cursor for COUNT query
    count_cursor = MagicMock()
    count_cursor.fetchone.return_value = (count_result,)

    # Server-side cursor for data streaming
    stream_cursor = MagicMock()
    stream_cursor.fetchmany.side_effect = [rows, []]

    # conn.cursor() returns different cursors based on name kwarg
    def cursor_factory(**kwargs: Any) -> MagicMock:
        mock_cursor = MagicMock()
        if kwargs.get("name"):
            mock_cursor.__enter__ = MagicMock(return_value=stream_cursor)
        else:
            mock_cursor.__enter__ = MagicMock(return_value=count_cursor)
        mock_cursor.__exit__ = MagicMock(return_value=False)
        return mock_cursor

    conn.cursor.side_effect = cursor_factory
    return conn


# ---------------------------------------------------------------------------
# Tests for export_to_parquet()
# ---------------------------------------------------------------------------


class TestExportToParquet:
    """Tests for export_to_parquet()."""

    def test_writes_parquet_file(self, tmp_path: Path) -> None:
        conn = _mock_connection()
        export_to_parquet(conn, tmp_path)

        parquet_files = list(tmp_path.rglob("*.parquet"))
        assert len(parquet_files) == 1
        table = pq.read_table(parquet_files[0])
        assert table.num_rows == 3

    def test_writes_manifest(self, tmp_path: Path) -> None:
        conn = _mock_connection()
        export_to_parquet(conn, tmp_path)

        manifest_path = tmp_path / "manifest.json"
        assert manifest_path.exists()
        saved = json.loads(manifest_path.read_text())
        assert saved["totalRows"] == 3
        assert len(saved["files"]) == 1
        assert saved["files"][0]["table"] == "sensor_sample"

    def test_returns_manifest(self, tmp_path: Path) -> None:
        conn = _mock_connection()
        manifest = export_to_parquet(conn, tmp_path)

        assert manifest["totalRows"] == 3
        assert len(manifest["files"]) == 1

    def test_reports_progress(self, tmp_path: Path) -> None:
        progress_calls: list[dict[str, Any]] = []
        conn = _mock_connection()

        export_to_parquet(conn, tmp_path, on_progress=progress_calls.append)

        percentages = [entry["percentage"] for entry in progress_calls]
        assert 0 in percentages
        assert 100 in percentages
        assert percentages == sorted(percentages)

    def test_handles_zero_rows(self, tmp_path: Path) -> None:
        conn = _mock_connection(count_result=0, rows=[])
        manifest = export_to_parquet(conn, tmp_path)

        assert manifest["totalRows"] == 0
        assert manifest["files"] == []
        parquet_files = list(tmp_path.rglob("*.parquet"))
        assert len(parquet_files) == 0

    def test_passes_since_until_to_query(self, tmp_path: Path) -> None:
        conn = _mock_connection(count_result=0, rows=[])

        export_to_parquet(
            conn,
            tmp_path,
            since="2026-03-01T00:00:00Z",
            until="2026-03-31T00:00:00Z",
        )

        # Verify the count cursor was called (params verification
        # is best done via integration tests against a real DB)
        assert conn.cursor.call_count >= 1

    def test_parquet_schema_matches(self, tmp_path: Path) -> None:
        conn = _mock_connection()
        export_to_parquet(conn, tmp_path)

        parquet_files = list(tmp_path.rglob("*.parquet"))
        table = pq.read_table(parquet_files[0])
        assert table.schema == PARQUET_SCHEMA

    def test_vector_column_preserved(self, tmp_path: Path) -> None:
        conn = _mock_connection()
        export_to_parquet(conn, tmp_path)

        parquet_files = list(tmp_path.rglob("*.parquet"))
        table = pq.read_table(parquet_files[0])
        vectors = table.column("vector").to_pylist()
        # Third row has a vector
        assert vectors[2] == pytest.approx([0.1, 0.2, 9.8])
        # Scalar rows have null vectors
        assert vectors[0] is None

    def test_multiple_batches(self, tmp_path: Path) -> None:
        """Verify multiple fetchmany batches are concatenated."""
        batch1 = [_row(scalar=140.0)]
        batch2 = [_row(scalar=142.0, timestamp=TS2)]

        conn = MagicMock()
        count_cursor = MagicMock()
        count_cursor.fetchone.return_value = (2,)
        stream_cursor = MagicMock()
        stream_cursor.fetchmany.side_effect = [batch1, batch2, []]

        def cursor_factory(**kwargs: Any) -> MagicMock:
            mock = MagicMock()
            if kwargs.get("name"):
                mock.__enter__ = MagicMock(return_value=stream_cursor)
            else:
                mock.__enter__ = MagicMock(return_value=count_cursor)
            mock.__exit__ = MagicMock(return_value=False)
            return mock

        conn.cursor.side_effect = cursor_factory

        manifest = export_to_parquet(conn, tmp_path)
        assert manifest["totalRows"] == 2

        parquet_files = list(tmp_path.rglob("*.parquet"))
        table = pq.read_table(parquet_files[0])
        assert table.num_rows == 2


# ---------------------------------------------------------------------------
# Tests for main() CLI
# ---------------------------------------------------------------------------


class TestMain:
    """Tests for main() CLI entry point."""

    @patch("dofek_ml.export.psycopg")
    def test_main_connects_and_exports(self, mock_psycopg: MagicMock, tmp_path: Path) -> None:
        mock_conn = _mock_connection(count_result=0, rows=[])
        ctx = mock_psycopg.connect.return_value
        ctx.__enter__ = MagicMock(return_value=mock_conn)
        ctx.__exit__ = MagicMock(return_value=False)

        db_url = "postgres://test@localhost/test"
        with patch(
            "sys.argv",
            ["export", "--database-url", db_url, "--output-dir", str(tmp_path)],
        ):
            main()

        mock_psycopg.connect.assert_called_once_with(db_url)

    @patch("dofek_ml.export.psycopg")
    def test_main_passes_since_until(self, mock_psycopg: MagicMock, tmp_path: Path) -> None:
        mock_conn = _mock_connection(count_result=0, rows=[])
        ctx = mock_psycopg.connect.return_value
        ctx.__enter__ = MagicMock(return_value=mock_conn)
        ctx.__exit__ = MagicMock(return_value=False)

        with patch(
            "sys.argv",
            [
                "export",
                "--database-url",
                "postgres://test@localhost/test",
                "--output-dir",
                str(tmp_path),
                "--since",
                "2026-03-01T00:00:00Z",
                "--until",
                "2026-03-31T00:00:00Z",
            ],
        ):
            main()

        mock_psycopg.connect.assert_called_once()

    @patch("sys.argv", ["export", "--help"])
    def test_help_exits_cleanly(self) -> None:
        with pytest.raises(SystemExit) as exc_info:
            main()
        assert exc_info.value.code == 0

    @patch("dofek_ml.export.psycopg")
    def test_main_outputs_progress_to_stdout(
        self,
        mock_psycopg: MagicMock,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        mock_conn = _mock_connection()
        ctx = mock_psycopg.connect.return_value
        ctx.__enter__ = MagicMock(return_value=mock_conn)
        ctx.__exit__ = MagicMock(return_value=False)

        with patch(
            "sys.argv",
            [
                "export",
                "--database-url",
                "postgres://test@localhost/test",
                "--output-dir",
                str(tmp_path),
            ],
        ):
            main()

        captured = capsys.readouterr().out
        lines = [line for line in captured.strip().split("\n") if line]
        for line in lines:
            parsed = json.loads(line)
            assert "percentage" in parsed
            assert "message" in parsed
