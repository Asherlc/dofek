"""
data_loading.py -- Data loading module for the fused CNN activity classifier.

Reads training data from either local Parquet files or Cloudflare R2 (S3-compatible).
The training data export job produces a single Parquet file from the unified
sensor_sample table. Each row has a `channel` column identifying the measurement
type (heart_rate, power, imu, orientation, etc.) and either a `scalar` value
(for single-value channels) or a `vector` value (for multi-axis channels).

The `vector` column is stored as a native list(float) in Parquet, so no string
parsing is needed (unlike the old CSV format which stored PostgreSQL array literals).

This module:
  - Loads the single Parquet file
  - Separates scalar channels from vector channels
  - Pivots scalar channels into a wide-format DataFrame (one column per channel)
  - Expands vector channels into separate axis columns

A manifest.json file lists available Parquet files and metadata.

Usage as a module:
    from dofek_ml.data_loading import load_training_data
    metric_df, device_df = load_training_data(local_path="/path/to/export/")

Usage as a CLI:
    python -m dofek_ml.data_loading --local-path /path/to/export/
    python -m dofek_ml.data_loading  # reads from R2 using env vars
"""

from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Channels that produce vector (multi-axis) data rather than scalar values.
VECTOR_CHANNELS: frozenset[str] = frozenset({"imu", "orientation"})

# Required columns in the Parquet schema. Used for validation at read time.
REQUIRED_PARQUET_COLUMNS: frozenset[str] = frozenset(
    {
        "recorded_at",
        "user_id",
        "provider_id",
        "device_id",
        "source_type",
        "channel",
        "activity_id",
        "activity_type",
        "scalar",
        "vector",
    }
)


# ---------------------------------------------------------------------------
# Parquet schema validation
# ---------------------------------------------------------------------------


def validate_parquet_schema(schema: pq.ParquetSchema) -> None:
    """Validate that a Parquet file contains all required columns.

    The Parquet file's embedded schema is the contract -- this function
    checks that all expected columns are present. Raises ValueError if
    any required column is missing.
    """
    column_names: frozenset[str] = frozenset(schema.names)
    missing: frozenset[str] = REQUIRED_PARQUET_COLUMNS - column_names
    if missing:
        raise ValueError(
            f"Parquet schema missing required columns: {sorted(missing)}. "
            f"Found columns: {sorted(column_names)}"
        )


# ---------------------------------------------------------------------------
# Manifest handling
# ---------------------------------------------------------------------------


def load_manifest_local(base_path: Path) -> dict[str, Any]:
    """Load manifest.json from a local directory.

    The manifest describes which Parquet files are available, their types
    (sensor_sample), and any metadata the export job attached.
    """
    manifest_path: Path = base_path / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(
            f"manifest.json not found at {manifest_path}. "
            "Make sure the training data export has been run."
        )
    with manifest_path.open() as f:
        manifest: dict[str, Any] = json.load(f)
    return manifest


def load_manifest_r2(s3_client: Any, bucket: str) -> dict[str, Any]:
    """Load manifest.json from Cloudflare R2 (S3-compatible).

    R2 uses the same S3 API, so we read the object into memory and parse it.
    """
    response: dict[str, Any] = s3_client.get_object(Bucket=bucket, Key="manifest.json")
    body: str = response["Body"].read().decode("utf-8")
    manifest: dict[str, Any] = json.loads(body)
    return manifest


# ---------------------------------------------------------------------------
# Parquet loading helpers
# ---------------------------------------------------------------------------


def read_parquet_local(base_path: Path, filename: str) -> pd.DataFrame:
    """Read a single Parquet file from the local filesystem.

    Validates the Parquet schema against the expected contract columns,
    then reads the file into a DataFrame.
    """
    filepath: Path = base_path / filename
    if not filepath.exists():
        raise FileNotFoundError(f"Parquet file not found: {filepath}")

    schema: pq.ParquetSchema = pq.read_schema(filepath)
    validate_parquet_schema(schema)

    df: pd.DataFrame = pd.read_parquet(filepath)
    df["recorded_at"] = pd.to_datetime(df["recorded_at"], format="ISO8601")
    return df


def read_parquet_r2(s3_client: Any, bucket: str, key: str) -> pd.DataFrame:
    """Read a single Parquet file from R2 into a pandas DataFrame.

    Downloads the object body into an in-memory buffer so pandas can parse it
    without writing a temp file to disk. Validates the schema before loading.
    """
    response: dict[str, Any] = s3_client.get_object(Bucket=bucket, Key=key)
    body: bytes = response["Body"].read()
    buffer: io.BytesIO = io.BytesIO(body)

    schema: pq.ParquetSchema = pq.read_schema(buffer)
    validate_parquet_schema(schema)
    buffer.seek(0)

    df: pd.DataFrame = pd.read_parquet(buffer)
    df["recorded_at"] = pd.to_datetime(df["recorded_at"], format="ISO8601")
    return df


# ---------------------------------------------------------------------------
# R2 client setup
# ---------------------------------------------------------------------------


def create_r2_client() -> Any:
    """Create a boto3 S3 client configured for Cloudflare R2.

    R2 is S3-compatible, so we use boto3 with a custom endpoint URL.
    Required env vars:
      - R2_ENDPOINT:          e.g. https://<account-id>.r2.cloudflarestorage.com
      - R2_ACCESS_KEY_ID:     R2 API token key ID
      - R2_SECRET_ACCESS_KEY: R2 API token secret
    """
    endpoint: str | None = os.environ.get("R2_ENDPOINT")
    access_key: str | None = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key: str | None = os.environ.get("R2_SECRET_ACCESS_KEY")

    if not all((endpoint, access_key, secret_key)):
        raise OSError(
            "R2 credentials not fully configured. Required env vars: "
            "R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY"
        )

    import boto3

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        # R2 does not use AWS regions, but boto3 requires one
        region_name="auto",
    )


# ---------------------------------------------------------------------------
# DataFrame transformation: channel-based rows -> wide format
# ---------------------------------------------------------------------------


def pivot_scalar_channels(raw_df: pd.DataFrame) -> pd.DataFrame:
    """Pivot scalar channel rows into a wide-format DataFrame.

    Input: rows with columns [recorded_at, user_id, provider_id, channel, scalar, ...]
    Output: one row per (recorded_at, user_id, activity_id) with columns for each
    scalar channel (heart_rate, power, cadence, speed, etc.)

    The resulting DataFrame is what the metric branch of the CNN expects:
    a timestamp column plus one numeric column per sensor channel.
    """
    scalar_df: pd.DataFrame = raw_df[~raw_df["channel"].isin(VECTOR_CHANNELS)].copy()

    if scalar_df.empty:
        return pd.DataFrame()

    # Pivot: each unique channel becomes its own column
    pivoted: pd.DataFrame = scalar_df.pivot_table(
        index=["recorded_at", "user_id", "activity_id", "activity_type", "provider_id"],
        columns="channel",
        values="scalar",
        aggfunc="first",
    ).reset_index()

    # Flatten the MultiIndex columns from pivot_table
    pivoted.columns = [col if not isinstance(col, tuple) else col for col in pivoted.columns]

    # Rename 'recorded_at' to 'timestamp' for compatibility with the training code
    return pivoted.rename(columns={"recorded_at": "timestamp"})


def expand_vector_channels(raw_df: pd.DataFrame) -> pd.DataFrame:
    """Expand vector channel rows into a wide-format DataFrame.

    Input: rows with a `vector` column containing native lists of floats
    (from Parquet's list(float) type) and a `channel` column (e.g., 'imu',
    'orientation').

    For IMU data (3 axes): expands to accel_x, accel_y, accel_z columns.
    For orientation data (4 axes): expands to w, x, y, z columns.

    The resulting DataFrame includes device_id as device_type for compatibility
    with the device branch of the CNN.
    """
    vector_df: pd.DataFrame = raw_df[raw_df["channel"].isin(VECTOR_CHANNELS)].copy()

    if vector_df.empty:
        return pd.DataFrame()

    # Reset index so positional access aligns with iloc
    vector_df = vector_df.reset_index(drop=True)

    # The vector column is already a native list of floats from Parquet --
    # no string parsing needed.
    parsed_vectors: dict[int, list[float]] = {
        i: list(v) if v is not None and not (isinstance(v, float) and np.isnan(v)) else []
        for i, v in enumerate(vector_df["vector"])
    }

    # Determine axis names based on channel and vector length
    result_frames: list[pd.DataFrame] = []

    for channel_name, channel_group in vector_df.groupby("channel"):
        group_indices: list[int] = list(channel_group.index)
        channel_vectors: list[list[float]] = [parsed_vectors[i] for i in group_indices]

        if not channel_vectors:
            continue

        # Determine axis names based on the channel type and vector length
        sample_length: int = len(channel_vectors[0]) if channel_vectors[0] else 0

        if str(channel_name) == "imu" and sample_length >= 3:
            axis_names: list[str] = ["accel_x", "accel_y", "accel_z"]
            if sample_length >= 6:
                axis_names.extend(["gyro_x", "gyro_y", "gyro_z"])
            axis_names = axis_names[:sample_length]
        elif str(channel_name) == "orientation" and sample_length >= 4:
            axis_names = ["w", "x", "y", "z"][:sample_length]
        else:
            axis_names = [f"axis_{i}" for i in range(sample_length)]

        # Build the expanded columns
        vector_array: np.ndarray = np.array(
            [
                v[:sample_length]
                if len(v) >= sample_length
                else v + [0.0] * (sample_length - len(v))
                for v in channel_vectors
            ],
            dtype=np.float64,
        )

        expanded: pd.DataFrame = pd.DataFrame(vector_array, columns=axis_names)
        expanded["timestamp"] = channel_group["recorded_at"].values
        expanded["device_type"] = channel_group["device_id"].values
        expanded["device_id"] = channel_group["device_id"].values
        expanded["user_id"] = channel_group["user_id"].values
        expanded["provider_id"] = channel_group["provider_id"].values

        result_frames.append(expanded)

    if not result_frames:
        return pd.DataFrame()

    combined: pd.DataFrame = pd.concat(result_frames, ignore_index=True)

    # Ensure timestamp is datetime
    if not pd.api.types.is_datetime64_any_dtype(combined["timestamp"]):
        combined["timestamp"] = pd.to_datetime(combined["timestamp"])

    return combined


# ---------------------------------------------------------------------------
# Main data loading functions
# ---------------------------------------------------------------------------


def load_from_local(base_path: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Load sensor_sample Parquet from a local directory and split into metric + device.

    Reads the manifest to discover which files exist, then loads and concatenates
    all sensor_sample files. Scalar channels are pivoted into a wide metric
    DataFrame; vector channels are expanded into a device DataFrame.

    Returns:
        (metric_df, device_df) -- two DataFrames ready for training.
    """
    manifest: dict[str, Any] = load_manifest_local(base_path)

    sensor_files: list[str] = [
        f["path"] for f in manifest["files"] if f["table"] == "sensor_sample"
    ]

    if not sensor_files:
        raise ValueError("No sensor_sample files listed in manifest")

    print(f"Loading {len(sensor_files)} sensor_sample file(s) from {base_path}")
    raw_dfs: list[pd.DataFrame] = [read_parquet_local(base_path, f) for f in sensor_files]
    raw_df: pd.DataFrame = pd.concat(raw_dfs, ignore_index=True)

    print(f"Raw sensor_sample: {len(raw_df)} rows, channels: {raw_df['channel'].unique().tolist()}")

    metric_df: pd.DataFrame = pivot_scalar_channels(raw_df)
    device_df: pd.DataFrame = expand_vector_channels(raw_df)

    if metric_df.empty:
        raise ValueError("No scalar channel data found in sensor_sample export")

    print(f"Metric stream: {len(metric_df)} rows, columns: {list(metric_df.columns)}")
    if not device_df.empty:
        print(f"Device stream: {len(device_df)} rows, columns: {list(device_df.columns)}")
    else:
        print("Device stream: 0 rows (no vector channel data)")

    return metric_df, device_df


def load_from_r2() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Load sensor_sample Parquet from Cloudflare R2 and split into metric + device.

    Same logic as load_from_local but fetches files over the network.
    The R2_BUCKET env var specifies which bucket to read from.

    Returns:
        (metric_df, device_df) -- two DataFrames ready for training.
    """
    bucket: str | None = os.environ.get("R2_BUCKET")
    if not bucket:
        raise OSError("R2_BUCKET env var is required for R2 mode")

    s3_client: Any = create_r2_client()
    manifest: dict[str, Any] = load_manifest_r2(s3_client, bucket)

    sensor_files: list[str] = [
        f["path"] for f in manifest["files"] if f["table"] == "sensor_sample"
    ]

    if not sensor_files:
        raise ValueError("No sensor_sample files listed in manifest")

    print(f"Downloading {len(sensor_files)} sensor_sample file(s) from R2 bucket '{bucket}'")
    raw_dfs: list[pd.DataFrame] = [read_parquet_r2(s3_client, bucket, f) for f in sensor_files]
    raw_df: pd.DataFrame = pd.concat(raw_dfs, ignore_index=True)

    print(f"Raw sensor_sample: {len(raw_df)} rows, channels: {raw_df['channel'].unique().tolist()}")

    metric_df: pd.DataFrame = pivot_scalar_channels(raw_df)
    device_df: pd.DataFrame = expand_vector_channels(raw_df)

    if metric_df.empty:
        raise ValueError("No scalar channel data found in sensor_sample export")

    print(f"Metric stream: {len(metric_df)} rows, columns: {list(metric_df.columns)}")
    if not device_df.empty:
        print(f"Device stream: {len(device_df)} rows, columns: {list(device_df.columns)}")
    else:
        print("Device stream: 0 rows (no vector channel data)")

    return metric_df, device_df


def load_training_data(
    local_path: str | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """High-level entry point: load training data from local path or R2.

    Decision logic:
      - If local_path is provided, read from the filesystem.
      - Otherwise, attempt to read from R2 using environment variables.

    This is the function other modules (like training.py) should call.

    Args:
        local_path: Optional filesystem path to the export directory.

    Returns:
        (metric_df, device_df) -- two DataFrames ready for training.
    """
    if local_path is not None:
        return load_from_local(Path(local_path))
    return load_from_r2()


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main() -> None:
    """CLI interface for testing data loading independently.

    Examples:
        # Load from local files:
        python -m dofek_ml.data_loading --local-path ./training-export/

        # Load from R2 (env vars must be set):
        R2_ENDPOINT=https://xxx.r2.cloudflarestorage.com \
        R2_ACCESS_KEY_ID=xxx \
        R2_SECRET_ACCESS_KEY=xxx \
        R2_BUCKET=training-data \
        python -m dofek_ml.data_loading
    """
    parser: argparse.ArgumentParser = argparse.ArgumentParser(
        description="Load training data from local Parquet files or Cloudflare R2"
    )
    parser.add_argument(
        "--local-path",
        type=str,
        default=None,
        help="Path to local directory containing manifest.json and Parquet files. "
        "If not provided, reads from R2 using environment variables.",
    )
    args: argparse.Namespace = parser.parse_args()

    metric_df, device_df = load_training_data(local_path=args.local_path)

    # Print summary statistics so the user can verify the data looks right
    print("\n--- Metric Stream Summary ---")
    print(metric_df.describe())
    if "activity_type" in metric_df.columns:
        print(f"\nActivity labels: {metric_df['activity_type'].value_counts().to_dict()}")

    print("\n--- Device Stream Summary ---")
    if not device_df.empty:
        print(device_df.describe())
        if "device_type" in device_df.columns:
            print(f"\nDevice types: {device_df['device_type'].unique().tolist()}")
    else:
        print("No device (vector channel) data available.")


if __name__ == "__main__":
    main()
