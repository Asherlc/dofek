"""
fetch_training_data.py -- Data loading module for the fused CNN activity classifier.

Reads training data from either local CSV files or Cloudflare R2 (S3-compatible).
The training data export job produces two CSV file types:
  - metric_stream: 1 Hz physiological/performance metrics (heart_rate, power, speed, etc.)
  - device_stream: 50 Hz raw sensor data per device (accelerometer, gyroscope axes)

A manifest.json file lists all available CSV files and their metadata.

Usage as a module:
    from fetch_training_data import load_training_data
    metric_df, device_df = load_training_data(local_path="/path/to/export/")

Usage as a CLI:
    python fetch_training_data.py --local-path /path/to/export/
    python fetch_training_data.py  # reads from R2 using env vars
"""

import argparse
import io
import json
import os
from pathlib import Path
from typing import Optional

import pandas as pd


# ---------------------------------------------------------------------------
# Manifest handling
# ---------------------------------------------------------------------------

def load_manifest_local(base_path: Path) -> dict:
    """Load manifest.json from a local directory.

    The manifest describes which CSV files are available, their types
    (metric_stream or device_stream), and any metadata the export job attached.
    """
    manifest_path = base_path / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(
            f"manifest.json not found at {manifest_path}. "
            "Make sure the training data export has been run."
        )
    with open(manifest_path, "r") as f:
        return json.load(f)


def load_manifest_r2(s3_client, bucket: str) -> dict:
    """Load manifest.json from Cloudflare R2 (S3-compatible).

    R2 uses the same S3 API, so we read the object into memory and parse it.
    """
    response = s3_client.get_object(Bucket=bucket, Key="manifest.json")
    body = response["Body"].read().decode("utf-8")
    return json.loads(body)


# ---------------------------------------------------------------------------
# CSV loading helpers
# ---------------------------------------------------------------------------

def read_csv_local(base_path: Path, filename: str) -> pd.DataFrame:
    """Read a single CSV file from the local filesystem.

    We let pandas infer most dtypes, but ensure timestamp columns are parsed
    as proper datetime objects for downstream time-alignment.
    """
    filepath = base_path / filename
    if not filepath.exists():
        raise FileNotFoundError(f"CSV file not found: {filepath}")
    df = pd.read_csv(filepath, parse_dates=["timestamp"])
    return df


def read_csv_r2(s3_client, bucket: str, key: str) -> pd.DataFrame:
    """Read a single CSV file from R2 into a pandas DataFrame.

    Downloads the object body into an in-memory buffer so pandas can parse it
    without writing a temp file to disk.
    """
    response = s3_client.get_object(Bucket=bucket, Key=key)
    body = response["Body"].read()
    df = pd.read_csv(io.BytesIO(body), parse_dates=["timestamp"])
    return df


# ---------------------------------------------------------------------------
# R2 client setup
# ---------------------------------------------------------------------------

def create_r2_client():
    """Create a boto3 S3 client configured for Cloudflare R2.

    R2 is S3-compatible, so we use boto3 with a custom endpoint URL.
    Required env vars:
      - R2_ENDPOINT:          e.g. https://<account-id>.r2.cloudflarestorage.com
      - R2_ACCESS_KEY_ID:     R2 API token key ID
      - R2_SECRET_ACCESS_KEY: R2 API token secret
    """
    import boto3

    endpoint = os.environ.get("R2_ENDPOINT")
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")

    if not all([endpoint, access_key, secret_key]):
        raise EnvironmentError(
            "R2 credentials not fully configured. Required env vars: "
            "R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY"
        )

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        # R2 does not use AWS regions, but boto3 requires one
        region_name="auto",
    )


# ---------------------------------------------------------------------------
# Main data loading functions
# ---------------------------------------------------------------------------

def load_from_local(base_path: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Load metric_stream and device_stream CSVs from a local directory.

    Reads the manifest to discover which files exist, then concatenates
    all metric_stream files into one DataFrame and all device_stream files
    into another. This supports exports that span multiple activities
    (one CSV per activity per stream type).

    Returns:
        (metric_df, device_df) -- two DataFrames ready for training.
    """
    manifest = load_manifest_local(base_path)

    metric_files = [
        f["filename"] for f in manifest["files"]
        if f["type"] == "metric_stream"
    ]
    device_files = [
        f["filename"] for f in manifest["files"]
        if f["type"] == "device_stream"
    ]

    if not metric_files:
        raise ValueError("No metric_stream files listed in manifest")
    if not device_files:
        raise ValueError("No device_stream files listed in manifest")

    print(f"Loading {len(metric_files)} metric_stream file(s) from {base_path}")
    metric_dfs = [read_csv_local(base_path, f) for f in metric_files]
    metric_df = pd.concat(metric_dfs, ignore_index=True)

    print(f"Loading {len(device_files)} device_stream file(s) from {base_path}")
    device_dfs = [read_csv_local(base_path, f) for f in device_files]
    device_df = pd.concat(device_dfs, ignore_index=True)

    print(f"Metric stream: {len(metric_df)} rows, columns: {list(metric_df.columns)}")
    print(f"Device stream: {len(device_df)} rows, columns: {list(device_df.columns)}")

    return metric_df, device_df


def load_from_r2() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Load metric_stream and device_stream CSVs from Cloudflare R2.

    Same logic as load_from_local but fetches files over the network.
    The R2_BUCKET env var specifies which bucket to read from.

    Returns:
        (metric_df, device_df) -- two DataFrames ready for training.
    """
    bucket = os.environ.get("R2_BUCKET")
    if not bucket:
        raise EnvironmentError("R2_BUCKET env var is required for R2 mode")

    s3_client = create_r2_client()
    manifest = load_manifest_r2(s3_client, bucket)

    metric_files = [
        f["filename"] for f in manifest["files"]
        if f["type"] == "metric_stream"
    ]
    device_files = [
        f["filename"] for f in manifest["files"]
        if f["type"] == "device_stream"
    ]

    if not metric_files:
        raise ValueError("No metric_stream files listed in manifest")
    if not device_files:
        raise ValueError("No device_stream files listed in manifest")

    print(f"Downloading {len(metric_files)} metric_stream file(s) from R2 bucket '{bucket}'")
    metric_dfs = [read_csv_r2(s3_client, bucket, f) for f in metric_files]
    metric_df = pd.concat(metric_dfs, ignore_index=True)

    print(f"Downloading {len(device_files)} device_stream file(s) from R2 bucket '{bucket}'")
    device_dfs = [read_csv_r2(s3_client, bucket, f) for f in device_files]
    device_df = pd.concat(device_dfs, ignore_index=True)

    print(f"Metric stream: {len(metric_df)} rows, columns: {list(metric_df.columns)}")
    print(f"Device stream: {len(device_df)} rows, columns: {list(device_df.columns)}")

    return metric_df, device_df


def load_training_data(
    local_path: Optional[str] = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """High-level entry point: load training data from local path or R2.

    Decision logic:
      - If local_path is provided, read from the filesystem.
      - Otherwise, attempt to read from R2 using environment variables.

    This is the function other modules (like train_activity_classifier.py)
    should call.

    Args:
        local_path: Optional filesystem path to the export directory.

    Returns:
        (metric_df, device_df) -- two DataFrames ready for training.
    """
    if local_path is not None:
        return load_from_local(Path(local_path))
    else:
        return load_from_r2()


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main():
    """CLI interface for testing data loading independently.

    Examples:
        # Load from local files:
        python fetch_training_data.py --local-path ./training-export/

        # Load from R2 (env vars must be set):
        R2_ENDPOINT=https://xxx.r2.cloudflarestorage.com \
        R2_ACCESS_KEY_ID=xxx \
        R2_SECRET_ACCESS_KEY=xxx \
        R2_BUCKET=training-data \
        python fetch_training_data.py
    """
    parser = argparse.ArgumentParser(
        description="Load training data from local CSV files or Cloudflare R2"
    )
    parser.add_argument(
        "--local-path",
        type=str,
        default=None,
        help="Path to local directory containing manifest.json and CSV files. "
             "If not provided, reads from R2 using environment variables.",
    )
    args = parser.parse_args()

    metric_df, device_df = load_training_data(local_path=args.local_path)

    # Print summary statistics so the user can verify the data looks right
    print("\n--- Metric Stream Summary ---")
    print(metric_df.describe())
    print(f"\nActivity labels: {metric_df['activity_type'].value_counts().to_dict()}")

    print("\n--- Device Stream Summary ---")
    print(device_df.describe())
    print(f"\nDevice types: {device_df['device_type'].unique().tolist()}")


if __name__ == "__main__":
    main()
