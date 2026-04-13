"""Tests for dofek_ml.training -- windowing, training loop, and evaluation."""

from __future__ import annotations

import runpy
from unittest.mock import patch

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("torch")

import torch

from dofek_ml.training import (
    DEFAULT_DEVICE_SAMPLE_RATE_HZ,
    DEFAULT_LABEL,
    LABEL_MAP,
    METRIC_GRID_SIZE,
    REST_LABEL,
    WINDOW_DURATION_SECONDS,
    DeviceBranch,
    FusedActivityModel,
    MetricBranch,
    build_device_windows,
    build_metric_windows,
    compute_device_grid_sizes,
    detect_device_sample_rate,
    discover_device_channels,
    discover_metric_channels,
    encode_labels,
    evaluate_model,
    run_ablation,
    simplify_label,
    train_model,
)


class TestSimplifyLabel:
    """Tests for simplify_label() -- the label mapping function."""

    def test_maps_cycling_variants_to_cycling(self) -> None:
        cycling_types: list[str] = [
            "cycling",
            "indoor_cycling",
            "road_cycling",
            "gravel_cycling",
            "mountain_biking",
            "virtual_cycling",
        ]
        for activity_type in cycling_types:
            assert simplify_label(activity_type) == "cycling", (
                f"Expected 'cycling' for '{activity_type}'"
            )

    def test_maps_hiking_to_hiking(self) -> None:
        assert simplify_label("hiking") == "hiking"

    def test_maps_walking_to_walking(self) -> None:
        assert simplify_label("walking") == "walking"

    def test_maps_none_to_rest(self) -> None:
        assert simplify_label(None) == REST_LABEL

    def test_maps_nan_to_rest(self) -> None:
        assert simplify_label(float("nan")) == REST_LABEL

    def test_maps_unknown_to_default_label(self) -> None:
        assert simplify_label("swimming") == DEFAULT_LABEL
        assert simplify_label("running") == DEFAULT_LABEL
        assert simplify_label("yoga") == DEFAULT_LABEL

    def test_case_insensitive(self) -> None:
        assert simplify_label("CYCLING") == "cycling"
        assert simplify_label("Indoor_Cycling") == "cycling"

    def test_strips_whitespace(self) -> None:
        assert simplify_label("  cycling  ") == "cycling"

    def test_label_map_values_are_valid(self) -> None:
        """Every value in LABEL_MAP should be a valid simplified label."""
        valid_labels: set[str] = {"cycling", "hiking", "walking"}
        for raw, simplified in LABEL_MAP.items():
            assert simplified in valid_labels, (
                f"LABEL_MAP['{raw}'] = '{simplified}' is not a valid label"
            )


class TestDiscoverMetricChannels:
    """Tests for discover_metric_channels()."""

    def test_excludes_metadata_columns(self) -> None:
        df: pd.DataFrame = pd.DataFrame(
            {
                "timestamp": pd.to_datetime(["2024-01-01"]),
                "activity_type": ["cycling"],
                "activity_id": [1],
                "user_id": [1],
                "source": ["wahoo"],
                "heart_rate": [140],
                "power": [200],
                "cadence": [90],
            }
        )
        channels: list[str] = discover_metric_channels(df)
        assert "heart_rate" in channels
        assert "power" in channels
        assert "cadence" in channels
        assert "timestamp" not in channels
        assert "activity_type" not in channels
        assert "activity_id" not in channels
        assert "user_id" not in channels
        assert "source" not in channels

    def test_returns_sorted_channels(self) -> None:
        df: pd.DataFrame = pd.DataFrame(
            {
                "timestamp": pd.to_datetime(["2024-01-01"]),
                "activity_type": ["cycling"],
                "power": [200],
                "cadence": [90],
                "heart_rate": [140],
            }
        )
        channels: list[str] = discover_metric_channels(df)
        assert channels == sorted(channels)

    def test_only_includes_numeric_columns(self) -> None:
        df: pd.DataFrame = pd.DataFrame(
            {
                "timestamp": pd.to_datetime(["2024-01-01"]),
                "activity_type": ["cycling"],
                "heart_rate": [140],
                "notes": ["felt good"],
            }
        )
        channels: list[str] = discover_metric_channels(df)
        assert "heart_rate" in channels
        assert "notes" not in channels


class TestDiscoverDeviceChannels:
    """Tests for discover_device_channels()."""

    def test_groups_by_device_type(self) -> None:
        df: pd.DataFrame = pd.DataFrame(
            {
                "timestamp": pd.to_datetime(["2024-01-01"] * 2),
                "device_type": ["watch", "power_meter"],
                "accel_x": [0.1, 0.2],
                "accel_y": [0.3, 0.4],
                "gyro_x": [1.0, float("nan")],
            }
        )
        channels: dict[str, list[str]] = discover_device_channels(df)
        assert "watch" in channels
        assert "power_meter" in channels

    def test_excludes_all_nan_channels(self) -> None:
        df: pd.DataFrame = pd.DataFrame(
            {
                "timestamp": pd.to_datetime(["2024-01-01"] * 2),
                "device_type": ["pm", "pm"],
                "accel_x": [0.1, 0.2],
                "gyro_x": [float("nan"), float("nan")],
            }
        )
        channels: dict[str, list[str]] = discover_device_channels(df)
        assert "accel_x" in channels["pm"]
        assert "gyro_x" not in channels["pm"]


class TestEncodeLabels:
    """Tests for encode_labels()."""

    def test_encodes_to_sequential_integers(self) -> None:
        labels: np.ndarray = np.array(["cycling", "rest", "hiking", "cycling"])
        encoded, class_names = encode_labels(labels)
        assert len(class_names) == 3
        assert encoded.dtype == torch.long
        assert len(encoded) == 4

    def test_class_names_are_sorted(self) -> None:
        labels: np.ndarray = np.array(["rest", "cycling", "hiking"])
        _, class_names = encode_labels(labels)
        assert class_names == sorted(class_names)

    def test_roundtrip(self) -> None:
        """Encoding then decoding should recover original labels."""
        labels: np.ndarray = np.array(["hiking", "cycling", "rest", "cycling"])
        encoded, class_names = encode_labels(labels)
        decoded: list[str] = [class_names[i] for i in encoded.tolist()]
        assert decoded == labels.tolist()


class TestMetricBranch:
    """Tests for MetricBranch nn.Module."""

    def test_output_shape(self) -> None:
        branch: MetricBranch = MetricBranch(in_channels=4)
        x: torch.Tensor = torch.randn(8, 4, METRIC_GRID_SIZE)
        out: torch.Tensor = branch(x)
        assert out.shape == (8, 64)

    def test_single_channel(self) -> None:
        branch: MetricBranch = MetricBranch(in_channels=1)
        x: torch.Tensor = torch.randn(2, 1, METRIC_GRID_SIZE)
        out: torch.Tensor = branch(x)
        assert out.shape == (2, 64)


class TestDeviceBranch:
    """Tests for DeviceBranch nn.Module."""

    def test_output_shape_50hz(self) -> None:
        branch: DeviceBranch = DeviceBranch(in_channels=6)
        grid_size: int = 50 * WINDOW_DURATION_SECONDS  # 3000
        x: torch.Tensor = torch.randn(8, 6, grid_size)
        out: torch.Tensor = branch(x)
        assert out.shape == (8, 128)

    def test_output_shape_100hz(self) -> None:
        """DeviceBranch should handle 100 Hz input (6000 slots) via AdaptiveAvgPool."""
        branch: DeviceBranch = DeviceBranch(in_channels=6)
        grid_size: int = 100 * WINDOW_DURATION_SECONDS  # 6000
        x: torch.Tensor = torch.randn(4, 6, grid_size)
        out: torch.Tensor = branch(x)
        assert out.shape == (4, 128)


class TestFusedActivityModel:
    """Tests for FusedActivityModel end-to-end forward pass."""

    def test_forward_pass_shape(self) -> None:
        model: FusedActivityModel = FusedActivityModel(
            metric_channels=4,
            device_channel_counts={"watch": 6, "power_meter": 3},
            num_classes=5,
        )
        batch_size: int = 4
        watch_grid: int = 50 * WINDOW_DURATION_SECONDS
        pm_grid: int = 50 * WINDOW_DURATION_SECONDS
        metric_input: torch.Tensor = torch.randn(batch_size, 4, METRIC_GRID_SIZE)
        device_inputs: dict[str, torch.Tensor] = {
            "watch": torch.randn(batch_size, 6, watch_grid),
            "power_meter": torch.randn(batch_size, 3, pm_grid),
        }
        logits: torch.Tensor = model(metric_input, device_inputs)
        assert logits.shape == (batch_size, 5)

    def test_single_device_type(self) -> None:
        model: FusedActivityModel = FusedActivityModel(
            metric_channels=2,
            device_channel_counts={"watch": 3},
            num_classes=3,
        )
        metric_input: torch.Tensor = torch.randn(2, 2, METRIC_GRID_SIZE)
        device_inputs: dict[str, torch.Tensor] = {
            "watch": torch.randn(2, 3, 50 * WINDOW_DURATION_SECONDS),
        }
        logits: torch.Tensor = model(metric_input, device_inputs)
        assert logits.shape == (2, 3)

    def test_mixed_sample_rates(self) -> None:
        """Devices with different sample rates should produce valid logits."""
        model: FusedActivityModel = FusedActivityModel(
            metric_channels=2,
            device_channel_counts={"apple_watch": 6, "whoop": 6},
            num_classes=3,
        )
        batch_size: int = 4
        metric_input: torch.Tensor = torch.randn(batch_size, 2, METRIC_GRID_SIZE)
        device_inputs: dict[str, torch.Tensor] = {
            "apple_watch": torch.randn(batch_size, 6, 50 * WINDOW_DURATION_SECONDS),
            "whoop": torch.randn(batch_size, 6, 100 * WINDOW_DURATION_SECONDS),
        }
        logits: torch.Tensor = model(metric_input, device_inputs)
        assert logits.shape == (batch_size, 3)


# ---------------------------------------------------------------------------
# Helpers for building synthetic DataFrames
# ---------------------------------------------------------------------------


def _make_metric_df(
    num_seconds: int,
    channels: list[str],
    activity_type: str = "cycling",
    start: str = "2024-01-01T00:00:00",
) -> pd.DataFrame:
    """Build a synthetic metric DataFrame with 1 Hz samples.

    ``num_seconds`` is the time *span* the data should cover. Because
    ``build_metric_windows`` computes ``total_seconds = t_max - t_min``,
    we need ``num_seconds + 1`` timestamps so the span equals exactly
    ``num_seconds`` seconds.  Each channel gets a simple ascending value
    so placement in the grid can be verified deterministically.
    """
    num_rows: int = num_seconds + 1
    timestamps: pd.DatetimeIndex = pd.date_range(start=start, periods=num_rows, freq="1s")
    data: dict[str, object] = {
        "timestamp": timestamps,
        "activity_type": [activity_type] * num_rows,
    }
    for ch in channels:
        data[ch] = np.arange(num_rows, dtype=np.float64)
    return pd.DataFrame(data)


def _make_device_df(
    num_samples: int,
    device_type: str,
    channels: list[str],
    start: str = "2024-01-01T00:00:00",
    freq: str = "20ms",
) -> pd.DataFrame:
    """Build a synthetic device DataFrame at 50 Hz (20 ms intervals)."""
    timestamps: pd.DatetimeIndex = pd.date_range(start=start, periods=num_samples, freq=freq)
    data: dict[str, object] = {
        "timestamp": timestamps,
        "device_type": [device_type] * num_samples,
    }
    for ch in channels:
        data[ch] = np.arange(num_samples, dtype=np.float64)
    return pd.DataFrame(data)


# ---------------------------------------------------------------------------
# build_metric_windows tests
# ---------------------------------------------------------------------------


class TestBuildMetricWindows:
    """Tests for build_metric_windows() -- slicing metric stream into 1 Hz grids."""

    def test_output_shapes_for_two_windows(self) -> None:
        """Two full 60-second windows should produce shape (2, C, 60)."""
        channels: list[str] = ["heart_rate", "power"]
        df: pd.DataFrame = _make_metric_df(num_seconds=120, channels=channels)

        windows: np.ndarray
        labels: np.ndarray
        start_times: list[pd.Timestamp]
        windows, labels, start_times = build_metric_windows(df, channels)

        assert windows.shape == (2, 2, METRIC_GRID_SIZE)
        assert len(labels) == 2
        assert len(start_times) == 2

    def test_values_land_in_correct_time_slots(self) -> None:
        """Sample at second N within a window should appear at slot N."""
        channels: list[str] = ["power"]
        # 60-second span = exactly 1 window (helper creates 61 rows)
        df: pd.DataFrame = _make_metric_df(num_seconds=60, channels=channels)

        windows, _labels, _start_times = build_metric_windows(df, channels)

        # The helper sets power = arange(61). The first window covers seconds
        # 0..59 (slots 0..59). Row i has timestamp=start+i and value=i.
        for slot in range(METRIC_GRID_SIZE):
            assert windows[0, 0, slot] == pytest.approx(float(slot)), (
                f"Slot {slot} expected {slot}, got {windows[0, 0, slot]}"
            )

    def test_gaps_remain_as_zeros(self) -> None:
        """If some seconds have no data, those slots stay at 0."""
        channels: list[str] = ["heart_rate"]
        # 60-second span (helper creates 61 rows, indices 0..60)
        df: pd.DataFrame = _make_metric_df(num_seconds=60, channels=channels)
        # Drop rows whose timestamps fall at seconds 20..39 within the window.
        # Row i has timestamp = start + i seconds, so drop rows 20..39.
        mask = (df.index >= 20) & (df.index < 40)
        df = df[~mask].reset_index(drop=True)

        windows, _labels, _start_times = build_metric_windows(df, channels)

        # Slots 20-39 should be zero because those rows were removed
        for slot in range(20, 40):
            assert windows[0, 0, slot] == 0.0, f"Slot {slot} should be 0 (gap)"

        # Slot 5 should still have value 5.0
        assert windows[0, 0, 5] == pytest.approx(5.0)

    def test_label_majority_vote(self) -> None:
        """Window label should be the most common activity type in that window."""
        channels: list[str] = ["heart_rate"]
        # 60-second span -> 61 rows, indices 0..60
        df: pd.DataFrame = _make_metric_df(
            num_seconds=60, channels=channels, activity_type="cycling"
        )
        # Override the last 10 rows to hiking -- cycling should still win (51 vs 10)
        df.loc[df.index >= 51, "activity_type"] = "hiking"

        _windows, labels, _start_times = build_metric_windows(df, channels)

        assert labels[0] == "cycling"

    def test_empty_window_labeled_rest(self) -> None:
        """A window with no data points should get the rest label."""
        channels: list[str] = ["heart_rate"]
        # 120-second span -> 121 rows covering 00:00:00..00:02:00
        df: pd.DataFrame = _make_metric_df(num_seconds=120, channels=channels)
        # Keep only the first window's data (seconds 0..59) and a single row
        # at second 120 to maintain the 120 s span for 2 windows.
        first_window: pd.DataFrame = df[
            df["timestamp"] < pd.Timestamp("2024-01-01T00:01:00")
        ].copy()
        end_row: pd.DataFrame = pd.DataFrame(
            {
                "timestamp": [pd.Timestamp("2024-01-01T00:02:00")],
                "activity_type": [None],
                "heart_rate": [0.0],
            }
        )
        df = pd.concat([first_window, end_row], ignore_index=True)

        _windows, labels, _start_times = build_metric_windows(df, channels)

        # Second window (60-120s) has no data in its interior -> rest
        assert labels[1] == REST_LABEL

    def test_raises_on_insufficient_data(self) -> None:
        """Data shorter than one window should raise ValueError."""
        channels: list[str] = ["heart_rate"]
        df: pd.DataFrame = _make_metric_df(num_seconds=30, channels=channels)

        with pytest.raises(ValueError, match="need at least"):
            build_metric_windows(df, channels)

    def test_nan_sensor_values_filled_with_zero(self) -> None:
        """NaN sensor readings within the window should become 0."""
        channels: list[str] = ["power"]
        # 60-second span -> 61 rows
        df: pd.DataFrame = _make_metric_df(num_seconds=60, channels=channels)
        df.loc[10, "power"] = float("nan")

        windows, _labels, _start_times = build_metric_windows(df, channels)

        assert windows[0, 0, 10] == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# build_device_windows tests
# ---------------------------------------------------------------------------


class TestDetectDeviceSampleRate:
    """Tests for detect_device_sample_rate()."""

    def test_detects_50hz(self) -> None:
        df: pd.DataFrame = _make_device_df(
            num_samples=500, device_type="watch", channels=["accel_x"], freq="20ms"
        )
        rate: int = detect_device_sample_rate(df, "watch")
        assert rate == 50

    def test_detects_100hz(self) -> None:
        df: pd.DataFrame = _make_device_df(
            num_samples=500, device_type="whoop", channels=["accel_x"], freq="10ms"
        )
        rate: int = detect_device_sample_rate(df, "whoop")
        assert rate == 100

    def test_falls_back_for_single_sample(self) -> None:
        df: pd.DataFrame = _make_device_df(num_samples=1, device_type="watch", channels=["accel_x"])
        rate: int = detect_device_sample_rate(df, "watch")
        assert rate == DEFAULT_DEVICE_SAMPLE_RATE_HZ

    def test_falls_back_for_missing_device(self) -> None:
        df: pd.DataFrame = _make_device_df(
            num_samples=100, device_type="watch", channels=["accel_x"]
        )
        rate: int = detect_device_sample_rate(df, "nonexistent")
        assert rate == DEFAULT_DEVICE_SAMPLE_RATE_HZ

    def test_falls_back_for_very_slow_rate(self) -> None:
        """Samples 2 seconds apart would give 0.5 Hz, which rounds to 0 — should fall back."""
        df: pd.DataFrame = _make_device_df(
            num_samples=10, device_type="slow", channels=["accel_x"], freq="2s"
        )
        rate: int = detect_device_sample_rate(df, "slow")
        assert rate == DEFAULT_DEVICE_SAMPLE_RATE_HZ


class TestComputeDeviceGridSizes:
    """Tests for compute_device_grid_sizes()."""

    def test_computes_from_rates(self) -> None:
        rates: dict[str, int] = {"watch": 50, "whoop": 100}
        sizes: dict[str, int] = compute_device_grid_sizes(rates)
        assert sizes == {"watch": 3000, "whoop": 6000}


class TestBuildDeviceWindows:
    """Tests for build_device_windows() -- slicing device stream into per-device-rate grids."""

    def test_output_shape(self) -> None:
        """Output should be (num_windows, num_channels, grid_size) per device."""
        channels: list[str] = ["accel_x", "accel_y"]
        device_channels: dict[str, list[str]] = {"watch": channels}
        # 3000 samples at 50 Hz = 60 seconds = 1 window
        df: pd.DataFrame = _make_device_df(num_samples=3000, device_type="watch", channels=channels)
        window_starts: list[pd.Timestamp] = [pd.Timestamp("2024-01-01T00:00:00")]

        result, rates = build_device_windows(df, device_channels, window_starts)

        assert "watch" in result
        expected_grid: int = rates["watch"] * WINDOW_DURATION_SECONDS
        assert result["watch"].shape == (1, 2, expected_grid)

    def test_values_placed_at_correct_slots(self) -> None:
        """A sample at second S should land at slot S * detected_rate."""
        channels: list[str] = ["accel_x"]
        device_channels: dict[str, list[str]] = {"watch": channels}
        timestamps: list[pd.Timestamp] = [
            pd.Timestamp("2024-01-01T00:00:00"),  # slot 0
            pd.Timestamp("2024-01-01T00:00:01"),  # slot = rate
            pd.Timestamp("2024-01-01T00:00:02"),  # slot = 2 * rate
        ]
        df: pd.DataFrame = pd.DataFrame(
            {
                "timestamp": timestamps,
                "device_type": ["watch"] * 3,
                "accel_x": [10.0, 20.0, 30.0],
            }
        )
        window_starts: list[pd.Timestamp] = [pd.Timestamp("2024-01-01T00:00:00")]
        # Explicitly set the rate since 3 samples isn't enough for detection
        explicit_rates: dict[str, int] = {"watch": 50}

        result, rates = build_device_windows(
            df, device_channels, window_starts, device_sample_rates=explicit_rates
        )
        grid: np.ndarray = result["watch"]

        assert grid[0, 0, 0] == pytest.approx(10.0)
        assert grid[0, 0, rates["watch"]] == pytest.approx(20.0)
        assert grid[0, 0, 2 * rates["watch"]] == pytest.approx(30.0)

    def test_gaps_remain_as_zeros(self) -> None:
        """Slots without data should stay at zero."""
        channels: list[str] = ["accel_x"]
        device_channels: dict[str, list[str]] = {"watch": channels}
        df: pd.DataFrame = pd.DataFrame(
            {
                "timestamp": [pd.Timestamp("2024-01-01T00:00:00")],
                "device_type": ["watch"],
                "accel_x": [42.0],
            }
        )
        window_starts: list[pd.Timestamp] = [pd.Timestamp("2024-01-01T00:00:00")]
        explicit_rates: dict[str, int] = {"watch": 50}

        result, _rates = build_device_windows(
            df, device_channels, window_starts, device_sample_rates=explicit_rates
        )
        grid: np.ndarray = result["watch"]

        assert grid[0, 0, 0] == pytest.approx(42.0)
        assert grid[0, 0, 1] == pytest.approx(0.0)
        assert grid[0, 0, 100] == pytest.approx(0.0)

    def test_multiple_device_types_with_different_rates(self) -> None:
        """Each device type should get its own grid sized to its sample rate."""
        watch_channels: list[str] = ["accel_x", "accel_y", "accel_z"]
        whoop_channels: list[str] = ["accel_x", "accel_y", "accel_z"]
        device_channels: dict[str, list[str]] = {
            "watch": watch_channels,
            "whoop": whoop_channels,
        }
        watch_df: pd.DataFrame = _make_device_df(
            num_samples=100, device_type="watch", channels=watch_channels, freq="20ms"
        )
        whoop_df: pd.DataFrame = _make_device_df(
            num_samples=100, device_type="whoop", channels=whoop_channels, freq="10ms"
        )
        df: pd.DataFrame = pd.concat([watch_df, whoop_df], ignore_index=True)
        window_starts: list[pd.Timestamp] = [pd.Timestamp("2024-01-01T00:00:00")]

        result, rates = build_device_windows(df, device_channels, window_starts)

        assert rates["watch"] == 50
        assert rates["whoop"] == 100
        assert result["watch"].shape == (1, 3, 50 * WINDOW_DURATION_SECONDS)
        assert result["whoop"].shape == (1, 3, 100 * WINDOW_DURATION_SECONDS)

    def test_empty_window_stays_zero(self) -> None:
        """A window with no device data should be all zeros."""
        channels: list[str] = ["accel_x"]
        device_channels: dict[str, list[str]] = {"watch": channels}
        df: pd.DataFrame = _make_device_df(num_samples=100, device_type="watch", channels=channels)
        window_starts: list[pd.Timestamp] = [
            pd.Timestamp("2024-01-01T00:00:00"),
            pd.Timestamp("2024-01-01T00:01:00"),  # no data here
        ]

        result, _rates = build_device_windows(df, device_channels, window_starts)

        assert np.all(result["watch"][1] == 0.0)


# ---------------------------------------------------------------------------
# Helpers for tiny model / tensor creation
# ---------------------------------------------------------------------------


WATCH_GRID_SIZE: int = DEFAULT_DEVICE_SAMPLE_RATE_HZ * WINDOW_DURATION_SECONDS


def _make_tiny_model(num_classes: int = 2) -> FusedActivityModel:
    """Create a small FusedActivityModel for fast tests."""
    return FusedActivityModel(
        metric_channels=2,
        device_channel_counts={"watch": 2},
        num_classes=num_classes,
    )


def _make_tiny_tensors(
    num_samples: int,
    num_classes: int = 2,
) -> tuple[
    torch.Tensor,
    dict[str, torch.Tensor],
    torch.Tensor,
]:
    """Create tiny synthetic tensors for training/evaluation tests.

    Returns (metric_tensor, device_tensors, labels).
    """
    metric: torch.Tensor = torch.randn(num_samples, 2, METRIC_GRID_SIZE)
    devices: dict[str, torch.Tensor] = {
        "watch": torch.randn(num_samples, 2, WATCH_GRID_SIZE),
    }
    labels: torch.Tensor = torch.randint(0, num_classes, (num_samples,))
    return metric, devices, labels


# ---------------------------------------------------------------------------
# train_model tests
# ---------------------------------------------------------------------------


class TestTrainModel:
    """Tests for train_model() -- the training loop."""

    def test_returns_trained_model_that_produces_predictions(self) -> None:
        """After training for 1 epoch, model should still produce valid logits."""
        num_classes: int = 2
        model: FusedActivityModel = _make_tiny_model(num_classes=num_classes)
        num_samples: int = 8

        metric_train, device_trains, labels_train = _make_tiny_tensors(num_samples, num_classes)
        metric_val, device_vals, labels_val = _make_tiny_tensors(4, num_classes)

        trained: FusedActivityModel = train_model(
            model=model,
            metric_train=metric_train,
            device_trains=device_trains,
            labels_train=labels_train,
            metric_val=metric_val,
            device_vals=device_vals,
            labels_val=labels_val,
            num_epochs=1,
            batch_size=4,
            learning_rate=1e-3,
        )

        # The trained model should still produce valid output
        trained.eval()
        with torch.no_grad():
            logits: torch.Tensor = trained(metric_val, device_vals)
        assert logits.shape == (4, num_classes)

    def test_model_weights_change_after_training(self) -> None:
        """Training should update model parameters (loss should drive gradient updates)."""
        num_classes: int = 2
        model: FusedActivityModel = _make_tiny_model(num_classes=num_classes)

        # Snapshot initial weights
        initial_weights: dict[str, torch.Tensor] = {
            name: param.clone() for name, param in model.named_parameters()
        }

        metric_train, device_trains, labels_train = _make_tiny_tensors(16, num_classes)
        metric_val, device_vals, labels_val = _make_tiny_tensors(4, num_classes)

        train_model(
            model=model,
            metric_train=metric_train,
            device_trains=device_trains,
            labels_train=labels_train,
            metric_val=metric_val,
            device_vals=device_vals,
            labels_val=labels_val,
            num_epochs=3,
            batch_size=8,
            learning_rate=1e-2,
        )

        # At least some parameters should have changed
        any_changed: bool = any(
            not torch.equal(initial_weights[name], param)
            for name, param in model.named_parameters()
        )
        assert any_changed, "Expected model weights to change after training"

    def test_batch_size_larger_than_dataset(self) -> None:
        """Training should work even when batch_size > num_samples (single batch)."""
        num_classes: int = 2
        model: FusedActivityModel = _make_tiny_model(num_classes=num_classes)
        metric_train, device_trains, labels_train = _make_tiny_tensors(4, num_classes)
        metric_val, device_vals, labels_val = _make_tiny_tensors(2, num_classes)

        trained: FusedActivityModel = train_model(
            model=model,
            metric_train=metric_train,
            device_trains=device_trains,
            labels_train=labels_train,
            metric_val=metric_val,
            device_vals=device_vals,
            labels_val=labels_val,
            num_epochs=1,
            batch_size=100,
            learning_rate=1e-3,
        )

        trained.eval()
        with torch.no_grad():
            logits: torch.Tensor = trained(metric_val, device_vals)
        assert logits.shape == (2, num_classes)


# ---------------------------------------------------------------------------
# evaluate_model tests
# ---------------------------------------------------------------------------


class TestEvaluateModel:
    """Tests for evaluate_model() -- accuracy and confusion matrix printing."""

    def test_prints_classification_report(self, capsys: pytest.CaptureFixture[str]) -> None:
        """evaluate_model should print a classification report and confusion matrix."""
        num_classes: int = 2
        class_names: list[str] = ["cycling", "rest"]
        model: FusedActivityModel = _make_tiny_model(num_classes=num_classes)
        metric_test, device_tests, labels_test = _make_tiny_tensors(8, num_classes)

        evaluate_model(model, metric_test, device_tests, labels_test, class_names)

        captured: str = capsys.readouterr().out
        assert "Classification Report" in captured
        assert "Confusion Matrix" in captured

    def test_prints_class_names_in_output(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Class names should appear in the printed output."""
        num_classes: int = 3
        class_names: list[str] = ["cycling", "hiking", "rest"]
        model: FusedActivityModel = FusedActivityModel(
            metric_channels=2,
            device_channel_counts={"watch": 2},
            num_classes=num_classes,
        )
        metric_test, device_tests, labels_test = _make_tiny_tensors(12, num_classes)

        evaluate_model(model, metric_test, device_tests, labels_test, class_names)

        captured: str = capsys.readouterr().out
        for name in class_names:
            assert name in captured, f"Expected class name '{name}' in output"


# ---------------------------------------------------------------------------
# run_ablation tests
# ---------------------------------------------------------------------------


class TestRunAblation:
    """Tests for run_ablation() -- branch zeroing ablation study."""

    def test_prints_ablation_header(self, capsys: pytest.CaptureFixture[str]) -> None:
        """run_ablation should print an ablation study header."""
        num_classes: int = 2
        class_names: list[str] = ["cycling", "rest"]
        model: FusedActivityModel = _make_tiny_model(num_classes=num_classes)
        metric_test, device_tests, labels_test = _make_tiny_tensors(8, num_classes)

        run_ablation(model, metric_test, device_tests, labels_test, class_names)

        captured: str = capsys.readouterr().out
        assert "Ablation Study" in captured

    def test_prints_baseline_accuracy(self, capsys: pytest.CaptureFixture[str]) -> None:
        """run_ablation should print the baseline (all branches active) accuracy."""
        num_classes: int = 2
        class_names: list[str] = ["cycling", "rest"]
        model: FusedActivityModel = _make_tiny_model(num_classes=num_classes)
        metric_test, device_tests, labels_test = _make_tiny_tensors(8, num_classes)

        run_ablation(model, metric_test, device_tests, labels_test, class_names)

        captured: str = capsys.readouterr().out
        assert "Baseline" in captured

    def test_prints_metric_branch_ablation(self, capsys: pytest.CaptureFixture[str]) -> None:
        """run_ablation should report accuracy without the metric branch."""
        num_classes: int = 2
        class_names: list[str] = ["cycling", "rest"]
        model: FusedActivityModel = _make_tiny_model(num_classes=num_classes)
        metric_test, device_tests, labels_test = _make_tiny_tensors(8, num_classes)

        run_ablation(model, metric_test, device_tests, labels_test, class_names)

        captured: str = capsys.readouterr().out
        assert "Without metric branch" in captured

    def test_prints_device_branch_ablation(self, capsys: pytest.CaptureFixture[str]) -> None:
        """run_ablation should report accuracy without each device branch."""
        num_classes: int = 2
        class_names: list[str] = ["cycling", "rest"]
        model: FusedActivityModel = _make_tiny_model(num_classes=num_classes)
        metric_test, device_tests, labels_test = _make_tiny_tensors(8, num_classes)

        run_ablation(model, metric_test, device_tests, labels_test, class_names)

        captured: str = capsys.readouterr().out
        assert "Without 'watch' branch" in captured

    def test_ablation_with_multiple_devices(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Ablation should list each device branch separately."""
        num_classes: int = 2
        class_names: list[str] = ["cycling", "rest"]
        model: FusedActivityModel = FusedActivityModel(
            metric_channels=2,
            device_channel_counts={"watch": 2, "chest_strap": 2},
            num_classes=num_classes,
        )
        num_samples: int = 8
        metric_test: torch.Tensor = torch.randn(num_samples, 2, METRIC_GRID_SIZE)
        device_tests: dict[str, torch.Tensor] = {
            "watch": torch.randn(num_samples, 2, WATCH_GRID_SIZE),
            "chest_strap": torch.randn(num_samples, 2, WATCH_GRID_SIZE),
        }
        labels_test: torch.Tensor = torch.randint(0, num_classes, (num_samples,))

        run_ablation(model, metric_test, device_tests, labels_test, class_names)

        captured: str = capsys.readouterr().out
        assert "Without 'watch' branch" in captured
        assert "Without 'chest_strap' branch" in captured


# ---------------------------------------------------------------------------
# Module guard test
# ---------------------------------------------------------------------------


class TestModuleGuard:
    """Tests for the ``if __name__ == '__main__'`` block."""

    @patch("sys.argv", ["training", "--help"])
    def test_name_main_invokes_main(self) -> None:
        """Running the module as __main__ triggers the guard and calls main().

        We pass ``--help`` so argparse prints usage and exits via SystemExit(0)
        *before* any data loading runs.  This covers the guard (line 892) and
        the argparse setup in main() (lines 699-738).
        """
        with pytest.raises(SystemExit) as exc_info:
            runpy.run_module("dofek_ml.training", run_name="__main__")
        assert exc_info.value.code == 0
