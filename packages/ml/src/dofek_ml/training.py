"""
train_activity_classifier.py -- Fused multi-device CNN activity classifier.

This script trains a neural network that classifies human activities (cycling,
hiking, walking, rest, etc.) by fusing two data streams at different sample rates:

  1. Metric stream (1 Hz): physiological data like heart_rate, power, cadence, speed.
     These come from ANT+/BLE sensors and are reported once per second.

  2. Device stream (50 Hz): raw accelerometer/gyroscope data from wearable devices.
     Each device type (watch, chest_strap, power_meter, etc.) may have different
     sensor channels. Data is recorded at the device's native 50 Hz sample rate.

The model uses separate convolutional branches for each input stream, then fuses
their learned features through concatenation before a final classifier head.
This "fused" architecture lets each branch learn at its native resolution --
the metric branch sees 60 samples per window (1 Hz x 60s), while each device
branch sees 3000 samples per window (50 Hz x 60s).

Usage:
    # Train from local export files:
    python train_activity_classifier.py --local-path ./training-export/

    # Train from R2 (set env vars first):
    python train_activity_classifier.py

    # Customize training:
    python train_activity_classifier.py --local-path ./data/ --epochs 20 --batch-size 64
"""

from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.optim as optim
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.model_selection import train_test_split

from dofek_ml.data_loading import load_training_data

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Window parameters -- these define how we slice continuous streams into
# fixed-size chunks that the CNN can process.
WINDOW_DURATION_SECONDS = 60  # Each training sample covers 60 seconds
METRIC_SAMPLE_RATE_HZ = 1  # Metric stream is recorded at 1 Hz

# Derived grid sizes (number of time slots per window)
METRIC_GRID_SIZE = WINDOW_DURATION_SECONDS * METRIC_SAMPLE_RATE_HZ  # 60 slots

# Default device sample rate used when no data is available to detect rate.
DEFAULT_DEVICE_SAMPLE_RATE_HZ = 50


# ---------------------------------------------------------------------------
# Label simplification
# ---------------------------------------------------------------------------

# The raw data contains fine-grained activity types from various providers.
# We collapse them into a small set of classes for the classifier. This keeps
# the model tractable and avoids classes with very few samples.
LABEL_MAP = {
    "cycling": "cycling",
    "indoor_cycling": "cycling",
    "road_cycling": "cycling",
    "gravel_cycling": "cycling",
    "mountain_biking": "cycling",
    "virtual_cycling": "cycling",
    "hiking": "hiking",
    "walking": "walking",
    # null/NaN activity_type means no activity was happening -- that is rest
}

# Everything not in LABEL_MAP (and not null) gets mapped to this catch-all.
# This includes things like running, swimming, strength_training, yoga, etc.
# that we don't have enough data to classify individually yet.
DEFAULT_LABEL = "activity"

# null/NaN activity_type means no activity was happening
REST_LABEL = "rest"


def simplify_label(raw_label: str | float | None) -> str:
    """Map a raw activity_type string to a simplified class label.

    Examples:
        simplify_label("indoor_cycling") -> "cycling"
        simplify_label("hiking")         -> "hiking"
        simplify_label(None)             -> "rest"
        simplify_label("swimming")       -> "activity"
    """
    if pd.isna(raw_label) or raw_label is None:
        return REST_LABEL
    raw_label = str(raw_label).lower().strip()
    return LABEL_MAP.get(raw_label, DEFAULT_LABEL)


# ---------------------------------------------------------------------------
# Data preprocessing: building time-aligned grids
# ---------------------------------------------------------------------------


def discover_metric_channels(metric_df: pd.DataFrame) -> list[str]:
    """Identify which numeric columns in the metric stream are sensor channels.

    We exclude structural/metadata columns and keep only the actual measurement
    channels that the CNN should learn from. The order of this list determines
    the channel ordering in the input tensor.
    """
    # Columns that are metadata, not sensor readings
    exclude_columns: set[str] = {"timestamp", "activity_type", "activity_id", "user_id", "source"}
    numeric_cols: list[str] = metric_df.select_dtypes(include=[np.number]).columns.tolist()
    channels: list[str] = [c for c in numeric_cols if c not in exclude_columns]
    channels.sort()  # Deterministic ordering
    return channels


def discover_device_channels(device_df: pd.DataFrame) -> dict[str, list[str]]:
    """Discover sensor channels available for each device type.

    Different devices have different sensors. A watch might report
    [accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z], while a power
    meter might only report [accel_x, accel_y, accel_z]. The CNN needs
    to know each device's channel count to size its input layers.

    Returns:
        Dict mapping device_type -> list of channel column names.
        Example: {"watch": ["accel_x", "accel_y", "accel_z", "gyro_x", ...]}
    """
    exclude_columns: set[str] = {
        "timestamp",
        "device_type",
        "device_id",
        "activity_id",
        "user_id",
        "source",
    }
    device_channels: dict[str, list[str]] = {}
    for device_type, group in device_df.groupby("device_type"):
        numeric_cols: list[str] = group.select_dtypes(include=[np.number]).columns.tolist()
        channels: list[str] = [c for c in numeric_cols if c not in exclude_columns]
        channels.sort()
        # Only include channels that actually have data for this device
        # (some columns may be all-NaN for certain device types)
        channels = [c for c in channels if group[c].notna().any()]
        device_channels[str(device_type)] = channels
    return device_channels


def build_metric_windows(
    metric_df: pd.DataFrame,
    metric_channels: list[str],
) -> tuple[np.ndarray, np.ndarray, list[pd.Timestamp]]:
    """Slice the metric stream into fixed-duration windows on a 1 Hz grid.

    Each window is a 2D array of shape (num_channels, METRIC_GRID_SIZE).
    Timestamps are placed at their correct position within the window so that
    gaps in the data remain as zeros (not padded at the end).

    Returns:
        windows:     np.ndarray of shape (num_windows, num_channels, 60)
        labels:      np.ndarray of simplified string labels, one per window
        start_times: list of window start timestamps (for debugging)
    """
    metric_df = metric_df.sort_values("timestamp").copy()
    metric_df["label"] = metric_df["activity_type"].apply(simplify_label)

    # Fill NaN sensor values with 0 (missing readings within an activity)
    metric_df[metric_channels] = metric_df[metric_channels].fillna(0)

    # Determine the time range of the data
    t_min: pd.Timestamp = metric_df["timestamp"].min()
    t_max: pd.Timestamp = metric_df["timestamp"].max()
    total_seconds: float = (t_max - t_min).total_seconds()

    # Number of non-overlapping windows we can extract
    num_windows: int = int(total_seconds // WINDOW_DURATION_SECONDS)
    if num_windows == 0:
        raise ValueError(
            f"Data spans only {total_seconds:.0f}s, need at least "
            f"{WINDOW_DURATION_SECONDS}s for one window"
        )

    num_channels: int = len(metric_channels)
    windows: np.ndarray = np.zeros(
        (num_windows, num_channels, METRIC_GRID_SIZE),
        dtype=np.float32,
    )
    labels: list[str] = []
    start_times: list[pd.Timestamp] = []

    for i in range(num_windows):
        # Define the time boundaries of this window
        window_start: pd.Timestamp = t_min + pd.Timedelta(seconds=i * WINDOW_DURATION_SECONDS)
        window_end: pd.Timestamp = window_start + pd.Timedelta(seconds=WINDOW_DURATION_SECONDS)

        # Select rows that fall within this window
        mask: pd.Series = (metric_df["timestamp"] >= window_start) & (
            metric_df["timestamp"] < window_end
        )
        window_data: pd.DataFrame = metric_df.loc[mask]

        if len(window_data) > 0:
            # Place each sample at its correct time slot within the window.
            # At 1 Hz, the slot index is just the number of seconds since
            # the window start. This preserves temporal gaps as zeros.
            offsets: pd.Series = (
                (window_data["timestamp"] - window_start)
                .dt.total_seconds()
                .astype(int)
                .clip(0, METRIC_GRID_SIZE - 1)
            )
            for ch_idx, ch_name in enumerate(metric_channels):
                values = np.asarray(window_data[ch_name].values)
                for slot, val in zip(offsets.values, values, strict=False):
                    windows[i, ch_idx, slot] = val

            # The window's label is the most common label among its samples
            # (majority vote). This handles windows that straddle activity
            # boundaries gracefully.
            label_counts: Counter[str] = Counter(window_data["label"].values)
            majority_label: str = label_counts.most_common(1)[0][0]
            labels.append(majority_label)
        else:
            # No data in this window -- treat as rest
            labels.append(REST_LABEL)

        start_times.append(window_start)

    return windows, np.array(labels), start_times


MIN_DEVICE_SAMPLE_RATE_HZ = 1
MAX_DEVICE_SAMPLE_RATE_HZ = 1000


def detect_device_sample_rate(device_df: pd.DataFrame, device_type: str) -> int:
    """Detect the sample rate (Hz) for a device type from its timestamp intervals.

    Uses the median inter-sample interval from the earliest 10,000 samples to
    determine the native rate. Falls back to DEFAULT_DEVICE_SAMPLE_RATE_HZ if
    there are fewer than 2 samples or the detected rate is outside [1, 1000] Hz.

    Returns:
        Detected sample rate rounded to the nearest integer Hz.
    """
    dev_data: pd.DataFrame = device_df[device_df["device_type"] == device_type]
    timestamps: pd.Series = dev_data["timestamp"]

    if len(timestamps) < 2:
        return DEFAULT_DEVICE_SAMPLE_RATE_HZ

    # Use a representative sample — nsmallest avoids sorting millions of rows
    # when only the earliest 10,000 timestamps are needed for interval estimation.
    sample_timestamps: pd.Series = timestamps.nsmallest(10_000)
    deltas: pd.Series = sample_timestamps.diff().dropna().dt.total_seconds()
    deltas = deltas[deltas > 0]

    if deltas.empty:
        return DEFAULT_DEVICE_SAMPLE_RATE_HZ

    median_interval: float = float(deltas.median())
    if median_interval <= 0:
        return DEFAULT_DEVICE_SAMPLE_RATE_HZ

    detected: int = round(1.0 / median_interval)
    if detected < MIN_DEVICE_SAMPLE_RATE_HZ or detected > MAX_DEVICE_SAMPLE_RATE_HZ:
        return DEFAULT_DEVICE_SAMPLE_RATE_HZ

    return detected


def detect_device_sample_rates(
    device_df: pd.DataFrame,
    device_channels: dict[str, list[str]],
) -> dict[str, int]:
    """Detect sample rates for all device types.

    Returns:
        Dict mapping device_type -> sample rate in Hz.
    """
    return {
        device_type: detect_device_sample_rate(device_df, device_type)
        for device_type in device_channels
    }


def compute_device_grid_sizes(device_sample_rates: dict[str, int]) -> dict[str, int]:
    """Compute the grid size (time slots per window) for each device type.

    Grid size = sample_rate_hz * WINDOW_DURATION_SECONDS.
    """
    return {
        device_type: rate * WINDOW_DURATION_SECONDS
        for device_type, rate in device_sample_rates.items()
    }


def build_device_windows(
    device_df: pd.DataFrame,
    device_channels: dict[str, list[str]],
    window_start_times: list[pd.Timestamp],
    device_sample_rates: dict[str, int] | None = None,
) -> tuple[dict[str, np.ndarray], dict[str, int]]:
    """Slice the device stream into fixed-duration windows at each device's native rate.

    Each device type gets its own array of shape:
        (num_windows, num_channels_for_device, grid_size)
    where grid_size = sample_rate * WINDOW_DURATION_SECONDS varies per device.

    The windows are aligned with the metric windows using the same start times.
    Samples are placed at their correct time slot (offset_seconds * sample_rate),
    so temporal gaps remain as zeros rather than being collapsed.

    Args:
        device_df:            Raw device stream DataFrame.
        device_channels:      Dict from discover_device_channels().
        window_start_times:   Start times from build_metric_windows() for alignment.
        device_sample_rates:  Optional per-device sample rates (Hz). If None,
                              auto-detected from timestamp intervals in the data.

    Returns:
        Tuple of:
          - Dict mapping device_type -> np.ndarray of shape (N, C, grid_size)
          - Dict mapping device_type -> detected sample rate in Hz
    """
    device_df = device_df.sort_values("timestamp").copy()

    if device_sample_rates is None:
        device_sample_rates = detect_device_sample_rates(device_df, device_channels)

    device_grid_sizes: dict[str, int] = compute_device_grid_sizes(device_sample_rates)
    num_windows: int = len(window_start_times)
    device_windows: dict[str, np.ndarray] = {}

    for device_type, channels in device_channels.items():
        sample_rate: int = device_sample_rates[device_type]
        grid_size: int = device_grid_sizes[device_type]
        num_channels: int = len(channels)
        grids: np.ndarray = np.zeros(
            (num_windows, num_channels, grid_size),
            dtype=np.float32,
        )

        # Filter to just this device type's data
        dev_data: pd.DataFrame = device_df[device_df["device_type"] == device_type].copy()
        dev_data[channels] = dev_data[channels].fillna(0)

        for i, window_start in enumerate(window_start_times):
            window_end: pd.Timestamp = window_start + pd.Timedelta(seconds=WINDOW_DURATION_SECONDS)
            mask: pd.Series = (dev_data["timestamp"] >= window_start) & (
                dev_data["timestamp"] < window_end
            )
            window_data: pd.DataFrame = dev_data.loc[mask]

            if len(window_data) > 0:
                offsets_seconds: pd.Series = (
                    window_data["timestamp"] - window_start
                ).dt.total_seconds()
                slot_indices: pd.Series = (offsets_seconds * sample_rate).astype(int)
                slot_indices = slot_indices.clip(0, grid_size - 1)

                for ch_idx, ch_name in enumerate(channels):
                    values = np.asarray(window_data[ch_name].values)
                    for slot, val in zip(slot_indices.values, values, strict=False):
                        grids[i, ch_idx, slot] = val

        device_windows[device_type] = grids
        print(
            f"  Device '{device_type}': {num_channels} channels, {sample_rate} Hz, "
            f"{grid_size} slots/window, {num_windows} windows"
        )

    return device_windows, device_sample_rates


# ---------------------------------------------------------------------------
# Model definition: FusedActivityModel
# ---------------------------------------------------------------------------


class MetricBranch(nn.Module):
    """CNN branch for 1 Hz metric data (heart_rate, power, speed, etc.).

    Processes 60-sample windows with progressively deeper convolutions.
    The small input size (60 time steps) means we use small kernels and
    moderate pooling to avoid collapsing the temporal dimension too fast.

    Architecture:
        Conv1d(in, 32, k=5) -> ReLU -> MaxPool(2)   -- 60 -> 28
        Conv1d(32, 64, k=3) -> ReLU -> MaxPool(2)    -- 28 -> 13
        Conv1d(64, 64, k=3) -> ReLU -> AdaptivePool(1) -- 13 -> 1
        Output: 64-dim feature vector per sample
    """

    def __init__(self, in_channels: int):
        super().__init__()
        self.conv_layers = nn.Sequential(
            nn.Conv1d(in_channels, 32, kernel_size=5, padding=2),
            nn.ReLU(),
            nn.MaxPool1d(2),
            nn.Conv1d(32, 64, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool1d(2),
            nn.Conv1d(64, 64, kernel_size=3, padding=1),
            nn.ReLU(),
            # Adaptive pooling collapses whatever temporal size remains to 1
            nn.AdaptiveAvgPool1d(1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Args:
            x: (batch, channels, 60) -- 1 Hz metric grid

        Returns:
            (batch, 64) -- learned feature vector
        """
        x = self.conv_layers(x)
        return x.squeeze(-1)  # Remove the length-1 temporal dim


class DeviceBranch(nn.Module):
    """CNN branch for 50 Hz device data (accelerometer, gyroscope, etc.).

    Processes 3000-sample windows. The larger input allows deeper convolutions
    and more aggressive pooling to capture both fine-grained motion patterns
    and longer temporal structure.

    Architecture:
        Conv1d(in, 32, k=7) -> ReLU -> MaxPool(4)    -- 3000 -> 750
        Conv1d(32, 64, k=5) -> ReLU -> MaxPool(4)     -- 750 -> 187
        Conv1d(64, 128, k=3) -> ReLU -> MaxPool(4)    -- 187 -> 46
        Conv1d(128, 128, k=3) -> ReLU -> AdaptivePool(1) -- 46 -> 1
        Output: 128-dim feature vector per sample
    """

    def __init__(self, in_channels: int):
        super().__init__()
        self.conv_layers = nn.Sequential(
            # First layer uses wider kernel to capture broader motion patterns
            nn.Conv1d(in_channels, 32, kernel_size=7, padding=3),
            nn.ReLU(),
            nn.MaxPool1d(4),
            nn.Conv1d(32, 64, kernel_size=5, padding=2),
            nn.ReLU(),
            nn.MaxPool1d(4),
            nn.Conv1d(64, 128, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool1d(4),
            nn.Conv1d(128, 128, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool1d(1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        Args:
            x: (batch, channels, 3000) -- 50 Hz device grid

        Returns:
            (batch, 128) -- learned feature vector
        """
        x = self.conv_layers(x)
        return x.squeeze(-1)


class FusedActivityModel(nn.Module):
    """Fused multi-device CNN for activity classification.

    The key idea: different data streams are processed by separate CNN branches
    at their native sample rates, then their learned features are concatenated
    and fed to a shared classifier head. This avoids resampling (which loses
    information) while still letting the model learn cross-stream correlations
    in the fusion layer.

    Structure:
        metric_branch  (1 Hz, 60 slots)  -> 64-dim features
        device branches (native Hz, variable slots each) -> 128-dim features each
        Classifier: concat all features -> FC -> ReLU -> Dropout -> FC -> classes

    Each device branch uses AdaptiveAvgPool1d(1) so it accepts any input length,
    allowing different devices to stream at different sample rates (e.g., 50 Hz
    for Apple Watch, 100 Hz for WHOOP).

    The device branches are stored in an nn.ModuleDict keyed by device_type,
    so the model automatically adapts to however many device types are present
    in the training data.
    """

    def __init__(
        self,
        metric_channels: int,
        device_channel_counts: dict[str, int],
        num_classes: int,
    ):
        """
        Args:
            metric_channels:       Number of 1 Hz metric channels (e.g., 4 for
                                   heart_rate, power, cadence, speed).
            device_channel_counts: Dict mapping device_type -> number of sensor
                                   channels for that device.
            num_classes:           Number of activity classes to predict.
        """
        super().__init__()

        # Branch for 1 Hz metric data
        self.metric_branch: MetricBranch = MetricBranch(metric_channels)
        metric_out_features: int = 64  # Matches MetricBranch output dim

        # One branch per device type, each sized for that device's channel count
        self.device_branches: nn.ModuleDict = nn.ModuleDict()
        device_out_features: int = 0
        for device_type, num_ch in sorted(device_channel_counts.items()):
            self.device_branches[device_type] = DeviceBranch(num_ch)
            device_out_features += 128  # Each DeviceBranch outputs 128-dim

        # Classifier head that fuses all branch outputs
        total_features: int = metric_out_features + device_out_features
        self.classifier: nn.Sequential = nn.Sequential(
            nn.Linear(total_features, 128),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(128, num_classes),
        )

        # Store device type ordering for consistent forward pass
        self.device_type_order: list[str] = sorted(device_channel_counts.keys())

        print(f"  Metric branch: {metric_channels} channels -> {metric_out_features} features")
        for dt in self.device_type_order:
            print(f"  Device branch '{dt}': {device_channel_counts[dt]} channels -> 128 features")
        print(f"  Classifier: {total_features} features -> {num_classes} classes")

    def forward(
        self,
        metric_input: torch.Tensor,
        device_inputs: dict[str, torch.Tensor],
    ) -> torch.Tensor:
        """
        Args:
            metric_input:  (batch, metric_channels, 60)
            device_inputs: Dict[device_type -> (batch, device_channels, 3000)]

        Returns:
            (batch, num_classes) -- raw logits (no softmax)
        """
        # Run each branch independently
        features: list[torch.Tensor] = [self.metric_branch(metric_input)]

        for device_type in self.device_type_order:
            branch: nn.Module = self.device_branches[device_type]
            device_input: torch.Tensor = device_inputs[device_type]
            features.append(branch(device_input))

        # Concatenate all branch outputs along the feature dimension
        fused: torch.Tensor = torch.cat(features, dim=1)

        # Classify based on fused features
        result: torch.Tensor = self.classifier(fused)
        return result


# ---------------------------------------------------------------------------
# Training loop
# ---------------------------------------------------------------------------


def encode_labels(labels: np.ndarray) -> tuple[torch.Tensor, list[str]]:
    """Convert string labels to integer class indices.

    Returns:
        encoded: LongTensor of class indices
        class_names: list of class names where index = class ID
    """
    unique_labels: list[str] = sorted(set(labels))
    label_to_idx: dict[str, int] = {label: idx for idx, label in enumerate(unique_labels)}
    encoded: torch.Tensor = torch.tensor(
        [label_to_idx[label] for label in labels],
        dtype=torch.long,
    )
    return encoded, unique_labels


def train_model(
    model: FusedActivityModel,
    metric_train: torch.Tensor,
    device_trains: dict[str, torch.Tensor],
    labels_train: torch.Tensor,
    metric_val: torch.Tensor,
    device_vals: dict[str, torch.Tensor],
    labels_val: torch.Tensor,
    num_epochs: int,
    batch_size: int,
    learning_rate: float,
) -> FusedActivityModel:
    """Train the model with standard cross-entropy loss.

    Uses a simple training loop with:
      - Adam optimizer (good default for CNNs)
      - Cross-entropy loss (standard for multi-class classification)
      - Per-epoch validation accuracy tracking

    Args:
        model:         The FusedActivityModel to train.
        metric_train:  Training metric windows (N, C, 60).
        device_trains: Training device windows per device type.
        labels_train:  Training labels (N,).
        metric_val:    Validation metric windows.
        device_vals:   Validation device windows per device type.
        labels_val:    Validation labels.
        num_epochs:    Number of training epochs.
        batch_size:    Mini-batch size.
        learning_rate: Adam learning rate.

    Returns:
        The trained model.
    """
    optimizer: optim.Adam = optim.Adam(model.parameters(), lr=learning_rate)
    criterion: nn.CrossEntropyLoss = nn.CrossEntropyLoss()

    # We need a custom batching approach since we have multiple inputs
    num_train: int = len(labels_train)

    for epoch in range(num_epochs):
        model.train()
        epoch_loss: float = 0.0
        num_batches: int = 0

        # Shuffle training data each epoch
        perm: torch.Tensor = torch.randperm(num_train)
        metric_train_shuffled: torch.Tensor = metric_train[perm]
        labels_train_shuffled: torch.Tensor = labels_train[perm]
        device_trains_shuffled: dict[str, torch.Tensor] = {
            dt: tensor[perm] for dt, tensor in device_trains.items()
        }

        for start in range(0, num_train, batch_size):
            end: int = min(start + batch_size, num_train)

            # Slice this batch from each input
            batch_metric: torch.Tensor = metric_train_shuffled[start:end]
            batch_labels: torch.Tensor = labels_train_shuffled[start:end]
            batch_devices: dict[str, torch.Tensor] = {
                dt: tensor[start:end] for dt, tensor in device_trains_shuffled.items()
            }

            # Forward pass
            logits: torch.Tensor = model(batch_metric, batch_devices)
            loss: torch.Tensor = criterion(logits, batch_labels)

            # Backward pass
            optimizer.zero_grad()
            loss.backward()  # type: ignore[no-untyped-call]  # torch stubs incomplete
            optimizer.step()

            epoch_loss += loss.item()
            num_batches += 1

        avg_loss: float = epoch_loss / max(num_batches, 1)

        # Validation accuracy
        model.eval()
        with torch.no_grad():
            val_logits: torch.Tensor = model(metric_val, device_vals)
            val_preds: torch.Tensor = val_logits.argmax(dim=1)
            val_accuracy: float = (val_preds == labels_val).float().mean().item()

        print(
            f"  Epoch {epoch + 1}/{num_epochs} -- "
            f"loss: {avg_loss:.4f}, val_accuracy: {val_accuracy:.4f}"
        )

    return model


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------


def evaluate_model(
    model: FusedActivityModel,
    metric_test: torch.Tensor,
    device_tests: dict[str, torch.Tensor],
    labels_test: torch.Tensor,
    class_names: list[str],
) -> None:
    """Evaluate the model and print per-class metrics.

    Prints:
      - Per-class precision, recall, F1-score (via sklearn classification_report)
      - Confusion matrix showing where the model gets confused
    """
    model.eval()
    with torch.no_grad():
        logits: torch.Tensor = model(metric_test, device_tests)
        preds: np.ndarray = logits.argmax(dim=1).numpy()

    labels_np: np.ndarray = labels_test.numpy()

    label_indices: np.ndarray = np.arange(len(class_names))

    print("\n=== Classification Report ===")
    print(
        classification_report(
            labels_np,
            preds,
            labels=label_indices,
            target_names=class_names,
            zero_division=0,
        )
    )

    print("=== Confusion Matrix ===")
    cm: np.ndarray = confusion_matrix(labels_np, preds, labels=label_indices)
    # Pretty-print with class labels
    header: str = "          " + "  ".join(f"{name:>10}" for name in class_names)
    print(header)
    for i, row in enumerate(cm):
        row_str: str = "  ".join(f"{val:>10}" for val in row)
        print(f"{class_names[i]:>10}  {row_str}")


def run_ablation(
    model: FusedActivityModel,
    metric_test: torch.Tensor,
    device_tests: dict[str, torch.Tensor],
    labels_test: torch.Tensor,
    _class_names: list[str],
) -> None:
    """Ablation study: test model with each branch zeroed out.

    This reveals how much each branch contributes to the final prediction.
    If zeroing out a branch causes a big accuracy drop, that branch is
    important. If accuracy barely changes, the branch may be redundant.

    We test:
      1. Metric branch zeroed (only device branches active)
      2. Each device branch zeroed individually (metric + other devices active)
    """
    model.eval()
    labels_np: np.ndarray = labels_test.numpy()

    print("\n=== Ablation Study ===")
    print("Testing model accuracy when each branch's input is zeroed out.\n")

    # Baseline accuracy (all branches active)
    with torch.no_grad():
        baseline_logits: torch.Tensor = model(metric_test, device_tests)
        baseline_preds: np.ndarray = baseline_logits.argmax(dim=1).numpy()
        baseline_acc: np.floating = (baseline_preds == labels_np).mean()
    print(f"  Baseline (all branches): {baseline_acc:.4f}")

    # Ablate metric branch: replace metric input with zeros
    with torch.no_grad():
        zeroed_metric: torch.Tensor = torch.zeros_like(metric_test)
        logits: torch.Tensor = model(zeroed_metric, device_tests)
        preds: np.ndarray = logits.argmax(dim=1).numpy()
        acc: np.floating = (preds == labels_np).mean()
    print(f"  Without metric branch:   {acc:.4f} (delta: {acc - baseline_acc:+.4f})")

    # Ablate each device branch individually
    for device_type in model.device_type_order:
        ablated_devices: dict[str, torch.Tensor] = {}
        for dt, tensor in device_tests.items():
            if dt == device_type:
                ablated_devices[dt] = torch.zeros_like(tensor)
            else:
                ablated_devices[dt] = tensor

        with torch.no_grad():
            logits = model(metric_test, ablated_devices)
            preds = logits.argmax(dim=1).numpy()
            acc = (preds == labels_np).mean()
        print(f"  Without '{device_type}' branch: {acc:.4f} (delta: {acc - baseline_acc:+.4f})")


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


def main() -> None:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(
        description="Train a fused CNN activity classifier on metric + device data"
    )
    parser.add_argument(
        "--local-path",
        type=str,
        default=None,
        help="Path to local directory with training CSVs. If omitted, reads from R2 via env vars.",
    )
    parser.add_argument(
        "--epochs",
        type=int,
        default=10,
        help="Number of training epochs (default: 10)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=32,
        help="Mini-batch size (default: 32)",
    )
    parser.add_argument(
        "--learning-rate",
        type=float,
        default=1e-3,
        help="Adam learning rate (default: 0.001)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="activity_classifier.pt",
        help="Path to save the trained model (default: activity_classifier.pt)",
    )
    parser.add_argument(
        "--test-size",
        type=float,
        default=0.2,
        help="Fraction of data to use for testing (default: 0.2)",
    )
    args: argparse.Namespace = parser.parse_args()

    # -----------------------------------------------------------------------
    # Step 1: Load raw data
    # -----------------------------------------------------------------------
    print("\n[1/6] Loading training data...")
    metric_df: pd.DataFrame
    device_df: pd.DataFrame
    metric_df, device_df = load_training_data(local_path=args.local_path)

    # -----------------------------------------------------------------------
    # Step 2: Discover channels and simplify labels
    # -----------------------------------------------------------------------
    print("\n[2/6] Discovering channels and preparing labels...")

    metric_channels: list[str] = discover_metric_channels(metric_df)
    print(f"  Metric channels ({len(metric_channels)}): {metric_channels}")

    device_channels: dict[str, list[str]] = discover_device_channels(device_df)
    for dt, channels in device_channels.items():
        print(f"  Device '{dt}' channels ({len(channels)}): {channels}")

    # Show label distribution before simplification
    raw_labels: pd.Series = metric_df["activity_type"].value_counts(dropna=False)
    print(f"\n  Raw label distribution:\n{raw_labels.to_string()}")

    # -----------------------------------------------------------------------
    # Step 3: Build time-aligned grids
    # -----------------------------------------------------------------------
    print("\n[3/6] Building time-aligned windows...")

    # Build metric windows first (they define the window start times)
    print("  Building metric windows (1 Hz, 60-second windows)...")
    metric_windows: np.ndarray
    labels: np.ndarray
    window_start_times: list[pd.Timestamp]
    metric_windows, labels, window_start_times = build_metric_windows(
        metric_df,
        metric_channels,
    )
    print(f"  Metric windows shape: {metric_windows.shape}")

    # Build device windows aligned to the same start times
    print("  Building device windows (per-device sample rate, 60-second windows)...")
    device_windows: dict[str, np.ndarray]
    device_sample_rates: dict[str, int]
    device_windows, device_sample_rates = build_device_windows(
        device_df,
        device_channels,
        window_start_times,
    )

    # Show simplified label distribution
    label_counts: Counter[str] = Counter(labels)
    print("\n  Simplified label distribution:")
    for label, count in sorted(label_counts.items()):
        print(f"    {label}: {count} windows")

    # -----------------------------------------------------------------------
    # Step 4: Train/test split and tensor conversion
    # -----------------------------------------------------------------------
    print("\n[4/6] Splitting data and converting to tensors...")

    # Encode string labels as integer class indices
    encoded_labels: torch.Tensor
    class_names: list[str]
    encoded_labels, class_names = encode_labels(labels)
    num_classes: int = len(class_names)
    print(f"  Classes ({num_classes}): {class_names}")

    # Create train/test indices (stratified to maintain class balance)
    indices: np.ndarray = np.arange(len(labels))
    train_idx: np.ndarray
    test_idx: np.ndarray
    train_idx, test_idx = train_test_split(
        indices,
        test_size=args.test_size,
        random_state=42,
        stratify=labels,
    )
    print(f"  Train: {len(train_idx)} windows, Test: {len(test_idx)} windows")

    # Split metric windows
    metric_train: torch.Tensor = torch.tensor(metric_windows[train_idx])
    metric_test: torch.Tensor = torch.tensor(metric_windows[test_idx])
    labels_train: torch.Tensor = encoded_labels[train_idx]
    labels_test: torch.Tensor = encoded_labels[test_idx]

    # Split device windows (one tensor per device type)
    device_trains: dict[str, torch.Tensor] = {}
    device_tests: dict[str, torch.Tensor] = {}
    for dt, windows in device_windows.items():
        device_trains[dt] = torch.tensor(windows[train_idx])
        device_tests[dt] = torch.tensor(windows[test_idx])

    # -----------------------------------------------------------------------
    # Step 5: Build and train the model
    # -----------------------------------------------------------------------
    print("\n[5/6] Building and training model...")

    device_channel_counts: dict[str, int] = {dt: len(chs) for dt, chs in device_channels.items()}

    model: FusedActivityModel = FusedActivityModel(
        metric_channels=len(metric_channels),
        device_channel_counts=device_channel_counts,
        num_classes=num_classes,
    )

    total_params: int = sum(p.numel() for p in model.parameters())
    trainable_params: int = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"\n  Total parameters: {total_params:,}")
    print(f"  Trainable parameters: {trainable_params:,}")

    print(f"\n  Training for {args.epochs} epochs with batch size {args.batch_size}...")
    model = train_model(
        model=model,
        metric_train=metric_train,
        device_trains=device_trains,
        labels_train=labels_train,
        metric_val=metric_test,  # Using test set as validation for simplicity
        device_vals=device_tests,
        labels_val=labels_test,
        num_epochs=args.epochs,
        batch_size=args.batch_size,
        learning_rate=args.learning_rate,
    )

    # -----------------------------------------------------------------------
    # Step 6: Evaluate and save
    # -----------------------------------------------------------------------
    print("\n[6/6] Evaluating model...")

    evaluate_model(model, metric_test, device_tests, labels_test, class_names)

    # Ablation study -- shows which branches matter most
    run_ablation(model, metric_test, device_tests, labels_test, class_names)

    # Save the trained model along with metadata needed for inference
    output_path: Path = Path(args.output)
    save_payload: dict[str, object] = {
        "model_state_dict": model.state_dict(),
        "class_names": class_names,
        "metric_channels": metric_channels,
        "device_channels": device_channels,
        "device_channel_counts": device_channel_counts,
        "window_duration_seconds": WINDOW_DURATION_SECONDS,
        "metric_sample_rate_hz": METRIC_SAMPLE_RATE_HZ,
        "device_sample_rates_hz": device_sample_rates,
    }
    torch.save(save_payload, output_path)
    print(f"\n  Model saved to {output_path}")
    print("  Saved metadata: class_names, channel info, grid parameters")
    print("\nDone!")


if __name__ == "__main__":
    main()
