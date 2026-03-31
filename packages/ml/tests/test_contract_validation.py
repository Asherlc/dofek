"""Tests for Parquet schema contract validation.

Validates that the Parquet file produced by the TypeScript export job contains
all required columns. The Parquet schema IS the contract -- no separate JSON
Schema is needed for runtime enforcement.

The JSON Schema file (contracts/sensor-export.schema.json) is kept as
documentation only.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

if TYPE_CHECKING:
    from pathlib import Path

from dofek_ml.data_loading import REQUIRED_PARQUET_COLUMNS, validate_parquet_schema


@pytest.fixture
def valid_parquet_file(tmp_path: Path) -> Path:
    """Create a valid Parquet file with all required columns."""
    table: pa.Table = pa.table(
        {
            "recorded_at": ["2026-03-30T15:00:00Z"],
            "user_id": ["a1b2c3d4-e5f6-7890-abcd-ef1234567890"],
            "provider_id": ["wahoo"],
            "device_id": pa.array([None], type=pa.string()),
            "source_type": ["ble"],
            "channel": ["heart_rate"],
            "activity_id": pa.array([None], type=pa.string()),
            "activity_type": ["cycling"],
            "scalar": [142.0],
            "vector": pa.array([None], type=pa.list_(pa.float64())),
        }
    )
    filepath: Path = tmp_path / "valid.parquet"
    pq.write_table(table, filepath)
    return filepath


class TestParquetSchemaContract:
    """Tests that Parquet files conform to the sensor export contract."""

    def test_valid_schema_passes(self, valid_parquet_file: Path) -> None:
        schema: pq.ParquetSchema = pq.read_schema(valid_parquet_file)
        validate_parquet_schema(schema)  # should not raise

    def test_all_required_columns_are_present(self, valid_parquet_file: Path) -> None:
        schema: pq.ParquetSchema = pq.read_schema(valid_parquet_file)
        column_names: set[str] = set(schema.names)
        for required_col in REQUIRED_PARQUET_COLUMNS:
            assert required_col in column_names, f"Missing required column: {required_col}"

    def test_missing_recorded_at_fails(self, tmp_path: Path) -> None:
        table: pa.Table = pa.table(
            {
                "user_id": ["user-1"],
                "provider_id": ["wahoo"],
                "device_id": pa.array([None], type=pa.string()),
                "source_type": ["ble"],
                "channel": ["heart_rate"],
                "activity_id": pa.array([None], type=pa.string()),
                "activity_type": ["cycling"],
                "scalar": [142.0],
                "vector": pa.array([None], type=pa.list_(pa.float64())),
            }
        )
        filepath: Path = tmp_path / "missing_recorded_at.parquet"
        pq.write_table(table, filepath)
        schema: pq.ParquetSchema = pq.read_schema(filepath)
        with pytest.raises(ValueError, match="missing required columns"):
            validate_parquet_schema(schema)

    def test_missing_channel_fails(self, tmp_path: Path) -> None:
        table: pa.Table = pa.table(
            {
                "recorded_at": ["2026-03-30T15:00:00Z"],
                "user_id": ["user-1"],
                "provider_id": ["wahoo"],
                "device_id": pa.array([None], type=pa.string()),
                "source_type": ["ble"],
                "activity_id": pa.array([None], type=pa.string()),
                "activity_type": ["cycling"],
                "scalar": [142.0],
                "vector": pa.array([None], type=pa.list_(pa.float64())),
            }
        )
        filepath: Path = tmp_path / "missing_channel.parquet"
        pq.write_table(table, filepath)
        schema: pq.ParquetSchema = pq.read_schema(filepath)
        with pytest.raises(ValueError, match="missing required columns"):
            validate_parquet_schema(schema)

    def test_missing_vector_fails(self, tmp_path: Path) -> None:
        table: pa.Table = pa.table(
            {
                "recorded_at": ["2026-03-30T15:00:00Z"],
                "user_id": ["user-1"],
                "provider_id": ["wahoo"],
                "device_id": pa.array([None], type=pa.string()),
                "source_type": ["ble"],
                "channel": ["heart_rate"],
                "activity_id": pa.array([None], type=pa.string()),
                "activity_type": ["cycling"],
                "scalar": [142.0],
            }
        )
        filepath: Path = tmp_path / "missing_vector.parquet"
        pq.write_table(table, filepath)
        schema: pq.ParquetSchema = pq.read_schema(filepath)
        with pytest.raises(ValueError, match="missing required columns"):
            validate_parquet_schema(schema)

    def test_missing_multiple_columns_reports_all(self, tmp_path: Path) -> None:
        table: pa.Table = pa.table(
            {
                "recorded_at": ["2026-03-30T15:00:00Z"],
                "user_id": ["user-1"],
            }
        )
        filepath: Path = tmp_path / "minimal.parquet"
        pq.write_table(table, filepath)
        schema: pq.ParquetSchema = pq.read_schema(filepath)
        with pytest.raises(ValueError, match="missing required columns") as exc_info:
            validate_parquet_schema(schema)
        error_msg: str = str(exc_info.value)
        # Should mention at least some of the missing columns
        assert "channel" in error_msg
        assert "vector" in error_msg
        assert "scalar" in error_msg

    def test_extra_columns_are_allowed(self, tmp_path: Path) -> None:
        """Parquet files may contain extra columns beyond the required ones."""
        columns: dict[str, Any] = {
            "recorded_at": ["2026-03-30T15:00:00Z"],
            "user_id": ["user-1"],
            "provider_id": ["wahoo"],
            "device_id": pa.array([None], type=pa.string()),
            "source_type": ["ble"],
            "channel": ["heart_rate"],
            "activity_id": pa.array([None], type=pa.string()),
            "activity_type": ["cycling"],
            "scalar": [142.0],
            "vector": pa.array([None], type=pa.list_(pa.float64())),
            "extra_column": ["bonus_data"],
        }
        table: pa.Table = pa.table(columns)
        filepath: Path = tmp_path / "extra_cols.parquet"
        pq.write_table(table, filepath)
        schema: pq.ParquetSchema = pq.read_schema(filepath)
        validate_parquet_schema(schema)  # should not raise

    def test_vector_column_is_list_type(self, valid_parquet_file: Path) -> None:
        """The vector column should be stored as a list(float) type in Parquet."""
        arrow_schema: pa.Schema = pq.read_schema(valid_parquet_file)
        vector_field: pa.Field = arrow_schema.field("vector")
        assert pa.types.is_list(vector_field.type), (
            f"Expected vector column to be list type, got {vector_field.type}"
        )
        assert pa.types.is_floating(vector_field.type.value_type), (
            f"Expected vector list items to be float, got {vector_field.type.value_type}"
        )

    def test_scalar_row_parquet(self, tmp_path: Path) -> None:
        """A complete scalar row should pass schema validation."""
        table: pa.Table = pa.table(
            {
                "recorded_at": ["2026-03-30T15:00:00Z"],
                "user_id": ["a1b2c3d4-e5f6-7890-abcd-ef1234567890"],
                "provider_id": ["wahoo"],
                "device_id": pa.array([None], type=pa.string()),
                "source_type": ["ble"],
                "channel": ["heart_rate"],
                "activity_id": pa.array([None], type=pa.string()),
                "activity_type": ["cycling"],
                "scalar": [142.0],
                "vector": pa.array([None], type=pa.list_(pa.float64())),
            }
        )
        filepath: Path = tmp_path / "scalar_row.parquet"
        pq.write_table(table, filepath)
        schema: pq.ParquetSchema = pq.read_schema(filepath)
        validate_parquet_schema(schema)

    def test_vector_row_parquet(self, tmp_path: Path) -> None:
        """A complete vector row should pass schema validation."""
        table: pa.Table = pa.table(
            {
                "recorded_at": ["2026-03-30T15:00:00.020Z"],
                "user_id": ["a1b2c3d4-e5f6-7890-abcd-ef1234567890"],
                "provider_id": ["apple_health"],
                "device_id": ["Apple Watch"],
                "source_type": ["ble"],
                "channel": ["imu"],
                "activity_id": pa.array([None], type=pa.string()),
                "activity_type": pa.array([None], type=pa.string()),
                "scalar": pa.array([None], type=pa.float64()),
                "vector": pa.array([[0.012, 0.138, -0.987]], type=pa.list_(pa.float64())),
            }
        )
        filepath: Path = tmp_path / "vector_row.parquet"
        pq.write_table(table, filepath)
        schema: pq.ParquetSchema = pq.read_schema(filepath)
        validate_parquet_schema(schema)
