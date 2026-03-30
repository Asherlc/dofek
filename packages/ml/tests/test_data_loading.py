"""Tests for dofek_ml.data_loading -- manifest parsing and data loading helpers."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock, patch

if TYPE_CHECKING:
    from pathlib import Path

import pandas as pd
import pytest

from dofek_ml.data_loading import (
    create_r2_client,
    load_from_local,
    load_from_r2,
    load_manifest_local,
    load_manifest_r2,
    load_training_data,
    main,
    read_csv_local,
    read_csv_r2,
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


# ---------------------------------------------------------------------------
# R2 / S3 mock helpers
# ---------------------------------------------------------------------------

SAMPLE_MANIFEST: dict[str, list[dict[str, str]]] = {
    "files": [
        {"filename": "metric_001.csv", "type": "metric_stream"},
        {"filename": "device_001.csv", "type": "device_stream"},
    ],
}

SAMPLE_METRIC_CSV: str = (
    "timestamp,activity_type,heart_rate,power\n"
    "2024-01-01T00:00:00,cycling,140,200\n"
    "2024-01-01T00:00:01,cycling,142,205\n"
)

SAMPLE_DEVICE_CSV: str = (
    "timestamp,device_type,accel_x,accel_y,accel_z\n"
    "2024-01-01T00:00:00.00,watch,0.1,0.2,9.8\n"
    "2024-01-01T00:00:00.02,watch,0.15,0.22,9.81\n"
)


def _mock_body(content: bytes) -> MagicMock:
    """Create a mock S3 response Body that supports .read()."""
    body: MagicMock = MagicMock()
    body.read.return_value = content
    return body


def _make_s3_client(files: dict[str, bytes]) -> MagicMock:
    """Create a mock S3 client that returns the given key->bytes mapping."""
    client: MagicMock = MagicMock()

    def get_object(Bucket: str, Key: str) -> dict[str, MagicMock]:  # noqa: N803
        if Key not in files:
            raise KeyError(f"NoSuchKey: {Key}")
        return {"Body": _mock_body(files[Key])}

    client.get_object.side_effect = get_object
    return client


# ---------------------------------------------------------------------------
# Tests for load_manifest_r2()
# ---------------------------------------------------------------------------


class TestLoadManifestR2:
    """Tests for load_manifest_r2()."""

    def test_loads_manifest_from_s3(self) -> None:
        s3_client: MagicMock = _make_s3_client(
            {"manifest.json": json.dumps(SAMPLE_MANIFEST).encode()}
        )
        manifest: dict[str, Any] = load_manifest_r2(s3_client, "test-bucket")
        assert "files" in manifest
        assert len(manifest["files"]) == 2

    def test_calls_get_object_with_correct_params(self) -> None:
        s3_client: MagicMock = _make_s3_client(
            {"manifest.json": json.dumps(SAMPLE_MANIFEST).encode()}
        )
        load_manifest_r2(s3_client, "my-bucket")
        s3_client.get_object.assert_called_once_with(Bucket="my-bucket", Key="manifest.json")

    def test_parses_file_entries(self) -> None:
        s3_client: MagicMock = _make_s3_client(
            {"manifest.json": json.dumps(SAMPLE_MANIFEST).encode()}
        )
        manifest: dict[str, Any] = load_manifest_r2(s3_client, "test-bucket")
        filenames: list[str] = [f["filename"] for f in manifest["files"]]
        assert "metric_001.csv" in filenames
        assert "device_001.csv" in filenames


# ---------------------------------------------------------------------------
# Tests for read_csv_r2()
# ---------------------------------------------------------------------------


class TestReadCsvR2:
    """Tests for read_csv_r2()."""

    def test_reads_csv_from_s3(self) -> None:
        s3_client: MagicMock = _make_s3_client({"metric_001.csv": SAMPLE_METRIC_CSV.encode()})
        df: pd.DataFrame = read_csv_r2(s3_client, "test-bucket", "metric_001.csv")
        assert len(df) == 2
        assert "heart_rate" in df.columns

    def test_parses_timestamps(self) -> None:
        s3_client: MagicMock = _make_s3_client({"metric_001.csv": SAMPLE_METRIC_CSV.encode()})
        df: pd.DataFrame = read_csv_r2(s3_client, "test-bucket", "metric_001.csv")
        assert pd.api.types.is_datetime64_any_dtype(df["timestamp"])

    def test_reads_device_csv(self) -> None:
        s3_client: MagicMock = _make_s3_client({"device_001.csv": SAMPLE_DEVICE_CSV.encode()})
        df: pd.DataFrame = read_csv_r2(s3_client, "test-bucket", "device_001.csv")
        assert len(df) == 2
        assert "device_type" in df.columns
        assert "accel_x" in df.columns

    def test_calls_get_object_with_correct_key(self) -> None:
        s3_client: MagicMock = _make_s3_client({"my-file.csv": SAMPLE_METRIC_CSV.encode()})
        read_csv_r2(s3_client, "bucket-x", "my-file.csv")
        s3_client.get_object.assert_called_once_with(Bucket="bucket-x", Key="my-file.csv")


# ---------------------------------------------------------------------------
# Tests for create_r2_client()
# ---------------------------------------------------------------------------


class TestCreateR2Client:
    """Tests for create_r2_client()."""

    @patch.dict(
        "os.environ",
        {
            "R2_ENDPOINT": "https://fake.r2.cloudflarestorage.com",
            "R2_ACCESS_KEY_ID": "fake-key-id",
            "R2_SECRET_ACCESS_KEY": "fake-secret",
        },
    )
    def test_creates_client_with_correct_params(self) -> None:
        mock_boto3: MagicMock = MagicMock()
        mock_boto3.client.return_value = MagicMock()
        with patch.dict("sys.modules", {"boto3": mock_boto3}):
            create_r2_client()
        mock_boto3.client.assert_called_once_with(
            "s3",
            endpoint_url="https://fake.r2.cloudflarestorage.com",
            aws_access_key_id="fake-key-id",
            aws_secret_access_key="fake-secret",
            region_name="auto",
        )

    @patch.dict(
        "os.environ",
        {
            "R2_ENDPOINT": "https://fake.r2.cloudflarestorage.com",
            "R2_ACCESS_KEY_ID": "fake-key-id",
            "R2_SECRET_ACCESS_KEY": "fake-secret",
        },
    )
    def test_returns_client(self) -> None:
        mock_boto3: MagicMock = MagicMock()
        sentinel: MagicMock = MagicMock()
        mock_boto3.client.return_value = sentinel
        with patch.dict("sys.modules", {"boto3": mock_boto3}):
            result: MagicMock = create_r2_client()
        assert result is sentinel

    @patch.dict("os.environ", {}, clear=True)
    def test_raises_when_no_env_vars(self) -> None:
        with pytest.raises(OSError, match="R2 credentials not fully configured"):
            create_r2_client()

    @patch.dict(
        "os.environ",
        {"R2_ENDPOINT": "https://fake.r2.cloudflarestorage.com"},
        clear=True,
    )
    def test_raises_when_partial_env_vars(self) -> None:
        with pytest.raises(OSError, match="R2 credentials not fully configured"):
            create_r2_client()


# ---------------------------------------------------------------------------
# Tests for load_from_r2()
# ---------------------------------------------------------------------------


class TestLoadFromR2:
    """Tests for load_from_r2()."""

    def _setup_r2_client(self) -> MagicMock:
        """Build a mock S3 client with manifest + CSV files."""
        return _make_s3_client(
            {
                "manifest.json": json.dumps(SAMPLE_MANIFEST).encode(),
                "metric_001.csv": SAMPLE_METRIC_CSV.encode(),
                "device_001.csv": SAMPLE_DEVICE_CSV.encode(),
            }
        )

    @patch.dict("os.environ", {"R2_BUCKET": "test-bucket"})
    @patch("dofek_ml.data_loading.create_r2_client")
    def test_returns_two_dataframes(self, mock_create: MagicMock) -> None:
        mock_create.return_value = self._setup_r2_client()
        metric_df, device_df = load_from_r2()
        assert isinstance(metric_df, pd.DataFrame)
        assert isinstance(device_df, pd.DataFrame)

    @patch.dict("os.environ", {"R2_BUCKET": "test-bucket"})
    @patch("dofek_ml.data_loading.create_r2_client")
    def test_metric_df_has_expected_rows(self, mock_create: MagicMock) -> None:
        mock_create.return_value = self._setup_r2_client()
        metric_df, _ = load_from_r2()
        assert len(metric_df) == 2

    @patch.dict("os.environ", {"R2_BUCKET": "test-bucket"})
    @patch("dofek_ml.data_loading.create_r2_client")
    def test_device_df_has_expected_rows(self, mock_create: MagicMock) -> None:
        mock_create.return_value = self._setup_r2_client()
        _, device_df = load_from_r2()
        assert len(device_df) == 2

    @patch.dict("os.environ", {}, clear=True)
    def test_raises_when_no_bucket_env(self) -> None:
        with pytest.raises(OSError, match="R2_BUCKET env var is required"):
            load_from_r2()

    @patch.dict("os.environ", {"R2_BUCKET": "test-bucket"})
    @patch("dofek_ml.data_loading.create_r2_client")
    def test_raises_on_no_metric_files(self, mock_create: MagicMock) -> None:
        manifest_no_metrics: dict[str, list[dict[str, str]]] = {
            "files": [{"filename": "device_001.csv", "type": "device_stream"}],
        }
        mock_create.return_value = _make_s3_client(
            {"manifest.json": json.dumps(manifest_no_metrics).encode()}
        )
        with pytest.raises(ValueError, match="No metric_stream files"):
            load_from_r2()

    @patch.dict("os.environ", {"R2_BUCKET": "test-bucket"})
    @patch("dofek_ml.data_loading.create_r2_client")
    def test_raises_on_no_device_files(self, mock_create: MagicMock) -> None:
        manifest_no_devices: dict[str, list[dict[str, str]]] = {
            "files": [{"filename": "metric_001.csv", "type": "metric_stream"}],
        }
        mock_create.return_value = _make_s3_client(
            {"manifest.json": json.dumps(manifest_no_devices).encode()}
        )
        with pytest.raises(ValueError, match="No device_stream files"):
            load_from_r2()


# ---------------------------------------------------------------------------
# Tests for load_training_data()
# ---------------------------------------------------------------------------


class TestLoadTrainingData:
    """Tests for load_training_data()."""

    def test_delegates_to_local_when_path_given(self, training_export_dir: Path) -> None:
        metric_df, device_df = load_training_data(local_path=str(training_export_dir))
        assert isinstance(metric_df, pd.DataFrame)
        assert isinstance(device_df, pd.DataFrame)

    @patch("dofek_ml.data_loading.load_from_r2")
    def test_delegates_to_r2_when_no_path(self, mock_load_r2: MagicMock) -> None:
        mock_metric: pd.DataFrame = pd.DataFrame({"timestamp": [], "activity_type": []})
        mock_device: pd.DataFrame = pd.DataFrame({"timestamp": [], "device_type": []})
        mock_load_r2.return_value = (mock_metric, mock_device)

        metric_df, device_df = load_training_data(local_path=None)

        mock_load_r2.assert_called_once()
        assert metric_df is mock_metric
        assert device_df is mock_device


# ---------------------------------------------------------------------------
# Tests for main() CLI
# ---------------------------------------------------------------------------


class TestMain:
    """Tests for main() CLI entry point."""

    @patch(
        "dofek_ml.data_loading.load_training_data",
        return_value=(
            pd.DataFrame(
                {
                    "timestamp": pd.to_datetime(["2024-01-01"]),
                    "activity_type": ["cycling"],
                    "heart_rate": [140],
                    "power": [200],
                }
            ),
            pd.DataFrame(
                {
                    "timestamp": pd.to_datetime(["2024-01-01"]),
                    "device_type": ["watch"],
                    "accel_x": [0.1],
                    "accel_y": [0.2],
                    "accel_z": [9.8],
                }
            ),
        ),
    )
    @patch("sys.argv", ["data_loading", "--local-path", "/fake/path"])
    def test_main_with_local_path(
        self, mock_load: MagicMock, capsys: pytest.CaptureFixture[str]
    ) -> None:
        main()
        mock_load.assert_called_once_with(local_path="/fake/path")
        captured: str = capsys.readouterr().out
        assert "Metric Stream Summary" in captured
        assert "Device Stream Summary" in captured
        assert "cycling" in captured
        assert "watch" in captured

    @patch(
        "dofek_ml.data_loading.load_training_data",
        return_value=(
            pd.DataFrame(
                {
                    "timestamp": pd.to_datetime(["2024-01-01"]),
                    "activity_type": ["running"],
                    "heart_rate": [155],
                }
            ),
            pd.DataFrame(
                {
                    "timestamp": pd.to_datetime(["2024-01-01"]),
                    "device_type": ["phone"],
                    "accel_x": [0.5],
                }
            ),
        ),
    )
    @patch("sys.argv", ["data_loading"])
    def test_main_without_local_path(
        self, mock_load: MagicMock, capsys: pytest.CaptureFixture[str]
    ) -> None:
        main()
        mock_load.assert_called_once_with(local_path=None)
        captured: str = capsys.readouterr().out
        assert "running" in captured
        assert "phone" in captured


# ---------------------------------------------------------------------------
# Tests for __name__ == "__main__" guard
# ---------------------------------------------------------------------------


class TestModuleGuard:
    """Test the if __name__ == '__main__' block (line 283)."""

    @patch("sys.argv", ["data_loading", "--help"])
    def test_name_main_invokes_main(self) -> None:
        """Running the module as __main__ triggers the guard and calls main().

        We pass ``--help`` so argparse prints usage and exits via SystemExit(0)
        *before* any data loading runs.  This is enough to prove the guard
        fires and covers line 283.
        """
        import runpy

        with pytest.raises(SystemExit) as exc_info:
            runpy.run_module("dofek_ml.data_loading", run_name="__main__")
        assert exc_info.value.code == 0
