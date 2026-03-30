"""Tests for train_activity_classifier.py -- label simplification and channel discovery."""

from __future__ import annotations

import numpy as np
import pandas as pd
import torch

from train_activity_classifier import (
    DEFAULT_LABEL,
    DEVICE_GRID_SIZE,
    LABEL_MAP,
    METRIC_GRID_SIZE,
    REST_LABEL,
    DeviceBranch,
    FusedActivityModel,
    MetricBranch,
    discover_device_channels,
    discover_metric_channels,
    encode_labels,
    simplify_label,
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
            assert (
                simplify_label(activity_type) == "cycling"
            ), f"Expected 'cycling' for '{activity_type}'"

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
            assert (
                simplified in valid_labels
            ), f"LABEL_MAP['{raw}'] = '{simplified}' is not a valid label"


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

    def test_output_shape(self) -> None:
        branch: DeviceBranch = DeviceBranch(in_channels=6)
        x: torch.Tensor = torch.randn(8, 6, DEVICE_GRID_SIZE)
        out: torch.Tensor = branch(x)
        assert out.shape == (8, 128)


class TestFusedActivityModel:
    """Tests for FusedActivityModel end-to-end forward pass."""

    def test_forward_pass_shape(self) -> None:
        model: FusedActivityModel = FusedActivityModel(
            metric_channels=4,
            device_channel_counts={"watch": 6, "power_meter": 3},
            num_classes=5,
        )
        batch_size: int = 4
        metric_input: torch.Tensor = torch.randn(batch_size, 4, METRIC_GRID_SIZE)
        device_inputs: dict[str, torch.Tensor] = {
            "watch": torch.randn(batch_size, 6, DEVICE_GRID_SIZE),
            "power_meter": torch.randn(batch_size, 3, DEVICE_GRID_SIZE),
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
            "watch": torch.randn(2, 3, DEVICE_GRID_SIZE),
        }
        logits: torch.Tensor = model(metric_input, device_inputs)
        assert logits.shape == (2, 3)
