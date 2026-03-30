"""Tests for dofek_ml.data_loading -- manifest parsing and data loading helpers."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

import pandas as pd
import pytest

from dofek_ml.data_loading import (
    load_from_local,
    load_manifest_local,
    read_csv_local,
)


@pytest.fixture
def training_export_dir(tmp_path: Path) -> Path:
    """Create a minimal training data export directory with manifest and CSVs."""
    manifest: dict[str, Any] = {
        "files": [
            {"filename": "metric_001.csv", "type": "metric_stream"},
            {"filename": "device_001.csv", "type": "device_stream"},
        ],
    }
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))

    # Create a minimal metric_stream CSV
    metric_csv: str = (
        "timestamp,activity_type,heart_rate,power\n"
        "2024-01-01T00:00:00,cycling,140,200\n"
        "2024-01-01T00:00:01,cycling,142,205\n"
        "2024-01-01T00:00:02,hiking,120,0\n"
    )
    (tmp_path / "metric_001.csv").write_text(metric_csv)

    # Create a minimal device_stream CSV
    device_csv: str = (
        "timestamp,device_type,accel_x,accel_y,accel_z\n"
        "2024-01-01T00:00:00.00,watch,0.1,0.2,9.8\n"
        "2024-01-01T00:00:00.02,watch,0.15,0.22,9.81\n"
        "2024-01-01T00:00:00.04,watch,0.12,0.19,9.79\n"
    )
    (tmp_path / "device_001.csv").write_text(device_csv)

    return tmp_path


class TestLoadManifestLocal:
    """Tests for load_manifest_local()."""

    def test_loads_valid_manifest(self, training_export_dir: Path) -> None:
        manifest: dict[str, Any] = load_manifest_local(training_export_dir)
        assert "files" in manifest
        assert len(manifest["files"]) == 2

    def test_raises_on_missing_manifest(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError, match="manifest.json not found"):
            load_manifest_local(tmp_path)

    def test_parses_file_types(self, training_export_dir: Path) -> None:
        manifest: dict[str, Any] = load_manifest_local(training_export_dir)
        file_types: list[str] = [f["type"] for f in manifest["files"]]
        assert "metric_stream" in file_types
        assert "device_stream" in file_types

    def test_parses_filenames(self, training_export_dir: Path) -> None:
        manifest: dict[str, Any] = load_manifest_local(training_export_dir)
        filenames: list[str] = [f["filename"] for f in manifest["files"]]
        assert "metric_001.csv" in filenames
        assert "device_001.csv" in filenames


class TestReadCsvLocal:
    """Tests for read_csv_local()."""

    def test_reads_metric_csv(self, training_export_dir: Path) -> None:
        df: pd.DataFrame = read_csv_local(training_export_dir, "metric_001.csv")
        assert len(df) == 3
        assert "timestamp" in df.columns
        assert "heart_rate" in df.columns
        assert "power" in df.columns

    def test_parses_timestamps(self, training_export_dir: Path) -> None:
        df: pd.DataFrame = read_csv_local(training_export_dir, "metric_001.csv")
        assert pd.api.types.is_datetime64_any_dtype(df["timestamp"])

    def test_reads_device_csv(self, training_export_dir: Path) -> None:
        df: pd.DataFrame = read_csv_local(training_export_dir, "device_001.csv")
        assert len(df) == 3
        assert "device_type" in df.columns
        assert "accel_x" in df.columns

    def test_raises_on_missing_file(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError, match="CSV file not found"):
            read_csv_local(tmp_path, "nonexistent.csv")


class TestLoadFromLocal:
    """Tests for load_from_local()."""

    def test_returns_two_dataframes(self, training_export_dir: Path) -> None:
        metric_df, device_df = load_from_local(training_export_dir)
        assert isinstance(metric_df, pd.DataFrame)
        assert isinstance(device_df, pd.DataFrame)

    def test_metric_df_has_expected_rows(self, training_export_dir: Path) -> None:
        metric_df, _ = load_from_local(training_export_dir)
        assert len(metric_df) == 3

    def test_device_df_has_expected_rows(self, training_export_dir: Path) -> None:
        _, device_df = load_from_local(training_export_dir)
        assert len(device_df) == 3

    def test_raises_on_no_metric_files(self, tmp_path: Path) -> None:
        manifest: dict[str, Any] = {
            "files": [
                {"filename": "device_001.csv", "type": "device_stream"},
            ],
        }
        (tmp_path / "manifest.json").write_text(json.dumps(manifest))
        with pytest.raises(ValueError, match="No metric_stream files"):
            load_from_local(tmp_path)

    def test_raises_on_no_device_files(self, tmp_path: Path) -> None:
        manifest: dict[str, Any] = {
            "files": [
                {"filename": "metric_001.csv", "type": "metric_stream"},
            ],
        }
        (tmp_path / "manifest.json").write_text(json.dumps(manifest))
        with pytest.raises(ValueError, match="No device_stream files"):
            load_from_local(tmp_path)

    def test_concatenates_multiple_metric_files(self, tmp_path: Path) -> None:
        """When the manifest lists multiple metric files, they get concatenated."""
        manifest: dict[str, Any] = {
            "files": [
                {"filename": "metric_001.csv", "type": "metric_stream"},
                {"filename": "metric_002.csv", "type": "metric_stream"},
                {"filename": "device_001.csv", "type": "device_stream"},
            ],
        }
        (tmp_path / "manifest.json").write_text(json.dumps(manifest))

        csv_content: str = "timestamp,activity_type,heart_rate\n2024-01-01T00:00:00,cycling,140\n"
        (tmp_path / "metric_001.csv").write_text(csv_content)
        (tmp_path / "metric_002.csv").write_text(csv_content)

        device_csv: str = "timestamp,device_type,accel_x\n2024-01-01T00:00:00,watch,0.1\n"
        (tmp_path / "device_001.csv").write_text(device_csv)

        metric_df, _ = load_from_local(tmp_path)
        assert len(metric_df) == 2  # Two files, one row each
