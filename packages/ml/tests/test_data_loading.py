"""Tests for dofek_ml.data_loading -- manifest parsing, data loading, and transformation."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock, patch

if TYPE_CHECKING:
    from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from dofek_ml.data_loading import (
    REQUIRED_PARQUET_COLUMNS,
    create_r2_client,
    expand_vector_channels,
    load_from_local,
    load_from_r2,
    load_manifest_local,
    load_manifest_r2,
    load_training_data,
    main,
    pivot_scalar_channels,
    read_parquet_local,
    read_parquet_r2,
    validate_parquet_schema,
)

# ---------------------------------------------------------------------------
# Shared test data for the new sensor_sample format (Parquet)
# ---------------------------------------------------------------------------

SAMPLE_MANIFEST: dict[str, Any] = {
    "exportedAt": "2024-01-01T00:00:00Z",
    "since": None,
    "until": None,
    "files": [
        {
            "path": "sensor_sample/2024-01-01T00:00:00Z.parquet",
            "table": "sensor_sample",
            "rowCount": 6,
        },
    ],
    "totalRows": 6,
}


def _build_sample_parquet_table() -> pa.Table:
    """Build a sample PyArrow table matching the sensor_sample export schema."""
    return pa.table(
        {
            "recorded_at": [
                "2024-01-01T00:00:00",
                "2024-01-01T00:00:00",
                "2024-01-01T00:00:01",
                "2024-01-01T00:00:01",
                "2024-01-01T00:00:00.00",
                "2024-01-01T00:00:00.02",
            ],
            "user_id": ["user-1"] * 6,
            "provider_id": [
                "wahoo",
                "wahoo",
                "wahoo",
                "wahoo",
                "apple_health",
                "apple_health",
            ],
            "device_id": [None, None, None, None, "Apple Watch", "Apple Watch"],
            "source_type": ["ble"] * 6,
            "channel": [
                "heart_rate",
                "power",
                "heart_rate",
                "power",
                "imu",
                "imu",
            ],
            "activity_id": ["act-1", "act-1", "act-1", "act-1", None, None],
            "activity_type": [
                "cycling",
                "cycling",
                "cycling",
                "cycling",
                None,
                None,
            ],
            "scalar": [140.0, 200.0, 142.0, 205.0, None, None],
            "vector": pa.array(
                [
                    None,
                    None,
                    None,
                    None,
                    [0.1, 0.2, 9.8],
                    [0.15, 0.22, 9.81],
                ],
                type=pa.list_(pa.float64()),
            ),
        }
    )


def _write_sample_parquet(path: Path) -> None:
    """Write the sample sensor data as a Parquet file."""
    table: pa.Table = _build_sample_parquet_table()
    pq.write_table(table, path)


def _parquet_bytes() -> bytes:
    """Return the sample Parquet file as bytes (for R2 mocking)."""
    import io

    table: pa.Table = _build_sample_parquet_table()
    buffer: io.BytesIO = io.BytesIO()
    pq.write_table(table, buffer)
    return buffer.getvalue()


@pytest.fixture
def training_export_dir(tmp_path: Path) -> Path:
    """Create a minimal training data export directory with manifest and Parquet."""
    (tmp_path / "manifest.json").write_text(json.dumps(SAMPLE_MANIFEST))

    # Create the sensor_sample subdirectory and Parquet file
    sensor_dir: Path = tmp_path / "sensor_sample"
    sensor_dir.mkdir()
    _write_sample_parquet(sensor_dir / "2024-01-01T00:00:00Z.parquet")

    return tmp_path


# ---------------------------------------------------------------------------
# Tests for validate_parquet_schema()
# ---------------------------------------------------------------------------


class TestValidateParquetSchema:
    """Tests for validate_parquet_schema()."""

    def test_valid_schema_passes(self, training_export_dir: Path) -> None:
        filepath: Path = training_export_dir / "sensor_sample" / "2024-01-01T00:00:00Z.parquet"
        schema: pq.ParquetSchema = pq.read_schema(filepath)
        validate_parquet_schema(schema)  # should not raise

    def test_missing_column_raises(self, tmp_path: Path) -> None:
        # Write a Parquet file missing the 'channel' column
        table: pa.Table = pa.table(
            {
                "recorded_at": ["2024-01-01T00:00:00"],
                "user_id": ["user-1"],
            }
        )
        filepath: Path = tmp_path / "incomplete.parquet"
        pq.write_table(table, filepath)
        schema: pq.ParquetSchema = pq.read_schema(filepath)
        with pytest.raises(ValueError, match="missing required columns"):
            validate_parquet_schema(schema)

    def test_all_required_columns_present(self) -> None:
        """Verify the constant matches what we expect."""
        assert "recorded_at" in REQUIRED_PARQUET_COLUMNS
        assert "channel" in REQUIRED_PARQUET_COLUMNS
        assert "vector" in REQUIRED_PARQUET_COLUMNS
        assert "scalar" in REQUIRED_PARQUET_COLUMNS


# ---------------------------------------------------------------------------
# Tests for pivot_scalar_channels()
# ---------------------------------------------------------------------------


class TestPivotScalarChannels:
    """Tests for pivot_scalar_channels()."""

    def test_pivots_scalar_channels_to_wide_format(self) -> None:
        raw_df: pd.DataFrame = pd.DataFrame(
            {
                "recorded_at": pd.to_datetime(
                    [
                        "2024-01-01T00:00:00",
                        "2024-01-01T00:00:00",
                        "2024-01-01T00:00:01",
                        "2024-01-01T00:00:01",
                    ]
                ),
                "user_id": ["u1", "u1", "u1", "u1"],
                "provider_id": ["wahoo", "wahoo", "wahoo", "wahoo"],
                "device_id": [None, None, None, None],
                "source_type": ["ble", "ble", "ble", "ble"],
                "channel": ["heart_rate", "power", "heart_rate", "power"],
                "activity_id": ["a1", "a1", "a1", "a1"],
                "activity_type": ["cycling", "cycling", "cycling", "cycling"],
                "scalar": [140.0, 200.0, 142.0, 205.0],
                "vector": [None, None, None, None],
            }
        )

        result: pd.DataFrame = pivot_scalar_channels(raw_df)

        assert "heart_rate" in result.columns
        assert "power" in result.columns
        assert "timestamp" in result.columns
        assert len(result) == 2

    def test_returns_empty_for_only_vector_channels(self) -> None:
        raw_df: pd.DataFrame = pd.DataFrame(
            {
                "recorded_at": pd.to_datetime(["2024-01-01T00:00:00"]),
                "user_id": ["u1"],
                "provider_id": ["apple_health"],
                "device_id": ["Watch"],
                "source_type": ["ble"],
                "channel": ["imu"],
                "activity_id": [None],
                "activity_type": [None],
                "scalar": [None],
                "vector": [[0.1, 0.2, 9.8]],
            }
        )

        result: pd.DataFrame = pivot_scalar_channels(raw_df)
        assert result.empty

    def test_excludes_vector_channels(self) -> None:
        raw_df: pd.DataFrame = pd.DataFrame(
            {
                "recorded_at": pd.to_datetime(
                    [
                        "2024-01-01T00:00:00",
                        "2024-01-01T00:00:00",
                    ]
                ),
                "user_id": ["u1", "u1"],
                "provider_id": ["wahoo", "apple_health"],
                "device_id": [None, "Watch"],
                "source_type": ["ble", "ble"],
                "channel": ["heart_rate", "imu"],
                "activity_id": ["a1", None],
                "activity_type": ["cycling", None],
                "scalar": [140.0, None],
                "vector": [None, [0.1, 0.2, 9.8]],
            }
        )

        result: pd.DataFrame = pivot_scalar_channels(raw_df)
        assert "heart_rate" in result.columns
        assert "imu" not in result.columns


# ---------------------------------------------------------------------------
# Tests for expand_vector_channels()
# ---------------------------------------------------------------------------


class TestExpandVectorChannels:
    """Tests for expand_vector_channels()."""

    def test_expands_imu_vectors_to_axes(self) -> None:
        raw_df: pd.DataFrame = pd.DataFrame(
            {
                "recorded_at": pd.to_datetime(
                    [
                        "2024-01-01T00:00:00.00",
                        "2024-01-01T00:00:00.02",
                    ]
                ),
                "user_id": ["u1", "u1"],
                "provider_id": ["apple_health", "apple_health"],
                "device_id": ["Watch", "Watch"],
                "source_type": ["ble", "ble"],
                "channel": ["imu", "imu"],
                "activity_id": [None, None],
                "activity_type": [None, None],
                "scalar": [None, None],
                "vector": [[0.1, 0.2, 9.8], [0.15, 0.22, 9.81]],
            }
        )

        result: pd.DataFrame = expand_vector_channels(raw_df)

        assert "accel_x" in result.columns
        assert "accel_y" in result.columns
        assert "accel_z" in result.columns
        assert "device_type" in result.columns
        assert len(result) == 2
        assert result["accel_x"].iloc[0] == pytest.approx(0.1)

    def test_expands_imu_with_gyroscope(self) -> None:
        raw_df: pd.DataFrame = pd.DataFrame(
            {
                "recorded_at": pd.to_datetime(["2024-01-01T00:00:00"]),
                "user_id": ["u1"],
                "provider_id": ["apple_health"],
                "device_id": ["Watch"],
                "source_type": ["ble"],
                "channel": ["imu"],
                "activity_id": [None],
                "activity_type": [None],
                "scalar": [None],
                "vector": [[0.1, 0.2, 9.8, 1.5, -0.3, 0.8]],
            }
        )

        result: pd.DataFrame = expand_vector_channels(raw_df)

        assert "accel_x" in result.columns
        assert "gyro_x" in result.columns
        assert result["gyro_x"].iloc[0] == pytest.approx(1.5)

    def test_expands_orientation_quaternion(self) -> None:
        raw_df: pd.DataFrame = pd.DataFrame(
            {
                "recorded_at": pd.to_datetime(["2024-01-01T00:00:00"]),
                "user_id": ["u1"],
                "provider_id": ["apple_health"],
                "device_id": ["Watch"],
                "source_type": ["ble"],
                "channel": ["orientation"],
                "activity_id": [None],
                "activity_type": [None],
                "scalar": [None],
                "vector": [[1.0, 0.0, 0.0, 0.0]],
            }
        )

        result: pd.DataFrame = expand_vector_channels(raw_df)

        assert "w" in result.columns
        assert "x" in result.columns
        assert "y" in result.columns
        assert "z" in result.columns
        assert result["w"].iloc[0] == pytest.approx(1.0)

    def test_returns_empty_for_no_vector_channels(self) -> None:
        raw_df: pd.DataFrame = pd.DataFrame(
            {
                "recorded_at": pd.to_datetime(["2024-01-01T00:00:00"]),
                "user_id": ["u1"],
                "provider_id": ["wahoo"],
                "device_id": [None],
                "source_type": ["ble"],
                "channel": ["heart_rate"],
                "activity_id": [None],
                "activity_type": [None],
                "scalar": [140.0],
                "vector": [None],
            }
        )

        result: pd.DataFrame = expand_vector_channels(raw_df)
        assert result.empty


# ---------------------------------------------------------------------------
# Tests for load_manifest_local()
# ---------------------------------------------------------------------------


class TestLoadManifestLocal:
    """Tests for load_manifest_local()."""

    def test_loads_valid_manifest(self, training_export_dir: Path) -> None:
        manifest: dict[str, Any] = load_manifest_local(training_export_dir)
        assert "files" in manifest
        assert len(manifest["files"]) == 1

    def test_raises_on_missing_manifest(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError, match="manifest.json not found"):
            load_manifest_local(tmp_path)

    def test_parses_file_table_type(self, training_export_dir: Path) -> None:
        manifest: dict[str, Any] = load_manifest_local(training_export_dir)
        tables: list[str] = [f["table"] for f in manifest["files"]]
        assert "sensor_sample" in tables

    def test_parses_file_paths(self, training_export_dir: Path) -> None:
        manifest: dict[str, Any] = load_manifest_local(training_export_dir)
        paths: list[str] = [f["path"] for f in manifest["files"]]
        assert "sensor_sample/2024-01-01T00:00:00Z.parquet" in paths


# ---------------------------------------------------------------------------
# Tests for read_parquet_local()
# ---------------------------------------------------------------------------


class TestReadParquetLocal:
    """Tests for read_parquet_local()."""

    def test_reads_sensor_parquet(self, training_export_dir: Path) -> None:
        df: pd.DataFrame = read_parquet_local(
            training_export_dir, "sensor_sample/2024-01-01T00:00:00Z.parquet"
        )
        assert len(df) == 6
        assert "recorded_at" in df.columns
        assert "channel" in df.columns
        assert "scalar" in df.columns

    def test_parses_timestamps(self, training_export_dir: Path) -> None:
        df: pd.DataFrame = read_parquet_local(
            training_export_dir, "sensor_sample/2024-01-01T00:00:00Z.parquet"
        )
        assert pd.api.types.is_datetime64_any_dtype(df["recorded_at"])

    def test_raises_on_missing_file(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError, match="Parquet file not found"):
            read_parquet_local(tmp_path, "nonexistent.parquet")

    def test_vector_column_is_native_list(self, training_export_dir: Path) -> None:
        """Verify that the vector column contains native arrays, not strings."""
        df: pd.DataFrame = read_parquet_local(
            training_export_dir, "sensor_sample/2024-01-01T00:00:00Z.parquet"
        )
        # Find an IMU row (has non-null vector)
        imu_rows: pd.DataFrame = df[df["channel"] == "imu"]
        assert len(imu_rows) > 0
        first_vector = imu_rows.iloc[0]["vector"]
        # Parquet list(float) columns are read as numpy arrays or Python lists
        assert hasattr(first_vector, "__iter__"), "vector should be iterable"
        assert not isinstance(first_vector, str), "vector should not be a string"
        values: list[float] = list(first_vector)
        assert len(values) == 3
        assert values == pytest.approx([0.1, 0.2, 9.8])


# ---------------------------------------------------------------------------
# Tests for load_from_local()
# ---------------------------------------------------------------------------


class TestLoadFromLocal:
    """Tests for load_from_local()."""

    def test_returns_two_dataframes(self, training_export_dir: Path) -> None:
        metric_df, device_df = load_from_local(training_export_dir)
        assert isinstance(metric_df, pd.DataFrame)
        assert isinstance(device_df, pd.DataFrame)

    def test_metric_df_has_pivoted_columns(self, training_export_dir: Path) -> None:
        metric_df, _ = load_from_local(training_export_dir)
        assert "timestamp" in metric_df.columns
        assert "heart_rate" in metric_df.columns
        assert "power" in metric_df.columns

    def test_metric_df_has_expected_rows(self, training_export_dir: Path) -> None:
        metric_df, _ = load_from_local(training_export_dir)
        # 4 scalar rows at 2 timestamps -> 2 pivoted rows
        assert len(metric_df) == 2

    def test_device_df_has_expanded_columns(self, training_export_dir: Path) -> None:
        _, device_df = load_from_local(training_export_dir)
        assert "accel_x" in device_df.columns
        assert "accel_y" in device_df.columns
        assert "accel_z" in device_df.columns
        assert "device_type" in device_df.columns

    def test_device_df_has_expected_rows(self, training_export_dir: Path) -> None:
        _, device_df = load_from_local(training_export_dir)
        assert len(device_df) == 2

    def test_raises_on_no_sensor_files(self, tmp_path: Path) -> None:
        manifest: dict[str, Any] = {
            "files": [],
            "totalRows": 0,
        }
        (tmp_path / "manifest.json").write_text(json.dumps(manifest))
        with pytest.raises(ValueError, match="No sensor_sample files"):
            load_from_local(tmp_path)


# ---------------------------------------------------------------------------
# R2 / S3 mock helpers
# ---------------------------------------------------------------------------


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
        assert len(manifest["files"]) == 1

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
        tables: list[str] = [f["table"] for f in manifest["files"]]
        assert "sensor_sample" in tables


# ---------------------------------------------------------------------------
# Tests for read_parquet_r2()
# ---------------------------------------------------------------------------


class TestReadParquetR2:
    """Tests for read_parquet_r2()."""

    def test_reads_parquet_from_s3(self) -> None:
        parquet_data: bytes = _parquet_bytes()
        s3_client: MagicMock = _make_s3_client({"sensor_001.parquet": parquet_data})
        df: pd.DataFrame = read_parquet_r2(s3_client, "test-bucket", "sensor_001.parquet")
        assert len(df) == 6
        assert "channel" in df.columns

    def test_parses_timestamps(self) -> None:
        parquet_data: bytes = _parquet_bytes()
        s3_client: MagicMock = _make_s3_client({"sensor_001.parquet": parquet_data})
        df: pd.DataFrame = read_parquet_r2(s3_client, "test-bucket", "sensor_001.parquet")
        assert pd.api.types.is_datetime64_any_dtype(df["recorded_at"])

    def test_calls_get_object_with_correct_key(self) -> None:
        parquet_data: bytes = _parquet_bytes()
        s3_client: MagicMock = _make_s3_client({"my-file.parquet": parquet_data})
        read_parquet_r2(s3_client, "bucket-x", "my-file.parquet")
        s3_client.get_object.assert_called_once_with(Bucket="bucket-x", Key="my-file.parquet")


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
        """Build a mock S3 client with manifest + Parquet files."""
        return _make_s3_client(
            {
                "manifest.json": json.dumps(SAMPLE_MANIFEST).encode(),
                "sensor_sample/2024-01-01T00:00:00Z.parquet": _parquet_bytes(),
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
    def test_metric_df_has_pivoted_columns(self, mock_create: MagicMock) -> None:
        mock_create.return_value = self._setup_r2_client()
        metric_df, _ = load_from_r2()
        assert "heart_rate" in metric_df.columns
        assert "power" in metric_df.columns

    @patch.dict("os.environ", {"R2_BUCKET": "test-bucket"})
    @patch("dofek_ml.data_loading.create_r2_client")
    def test_device_df_has_expanded_columns(self, mock_create: MagicMock) -> None:
        mock_create.return_value = self._setup_r2_client()
        _, device_df = load_from_r2()
        assert "accel_x" in device_df.columns

    @patch.dict("os.environ", {}, clear=True)
    def test_raises_when_no_bucket_env(self) -> None:
        with pytest.raises(OSError, match="R2_BUCKET env var is required"):
            load_from_r2()

    @patch.dict("os.environ", {"R2_BUCKET": "test-bucket"})
    @patch("dofek_ml.data_loading.create_r2_client")
    def test_raises_on_no_sensor_files(self, mock_create: MagicMock) -> None:
        manifest_empty: dict[str, Any] = {
            "files": [],
            "totalRows": 0,
        }
        mock_create.return_value = _make_s3_client(
            {"manifest.json": json.dumps(manifest_empty).encode()}
        )
        with pytest.raises(ValueError, match="No sensor_sample files"):
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
            pd.DataFrame(),  # empty device df
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
        assert "No device (vector channel) data" in captured


# ---------------------------------------------------------------------------
# Tests for __name__ == "__main__" guard
# ---------------------------------------------------------------------------


class TestModuleGuard:
    """Test the if __name__ == '__main__' block."""

    @patch("sys.argv", ["data_loading", "--help"])
    def test_name_main_invokes_main(self) -> None:
        """Running the module as __main__ triggers the guard and calls main().

        We pass ``--help`` so argparse prints usage and exits via SystemExit(0)
        *before* any data loading runs.  This is enough to prove the guard
        fires and covers the if __name__ guard.
        """
        import runpy

        with pytest.raises(SystemExit) as exc_info:
            runpy.run_module("dofek_ml.data_loading", run_name="__main__")
        assert exc_info.value.code == 0
