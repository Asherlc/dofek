"""Tests for contract validation between TypeScript export and Python loading.

Validates that sample sensor_sample export data conforms to the shared
JSON Schema contract defined in contracts/sensor-export.schema.json.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import jsonschema
import pytest

# Path to the shared contract schema at the repo root
CONTRACT_SCHEMA_PATH: Path = (
    Path(__file__).resolve().parent.parent.parent.parent / "contracts" / "sensor-export.schema.json"
)


@pytest.fixture
def contract_schema() -> dict[str, Any]:
    """Load the sensor export contract schema."""
    if not CONTRACT_SCHEMA_PATH.exists():
        pytest.skip(f"Contract schema not found at {CONTRACT_SCHEMA_PATH}")
    with CONTRACT_SCHEMA_PATH.open() as f:
        schema: dict[str, Any] = json.load(f)
    return schema


class TestContractValidation:
    """Tests that sample data conforms to the sensor export contract."""

    def test_valid_scalar_row_passes(self, contract_schema: dict[str, Any]) -> None:
        row: dict[str, Any] = {
            "recorded_at": "2026-03-30T15:00:00Z",
            "user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "provider_id": "wahoo",
            "device_id": None,
            "source_type": "ble",
            "channel": "heart_rate",
            "activity_id": None,
            "activity_type": "cycling",
            "scalar": 142,
            "vector": None,
        }
        jsonschema.validate(instance=row, schema=contract_schema)

    def test_valid_vector_row_passes(self, contract_schema: dict[str, Any]) -> None:
        row: dict[str, Any] = {
            "recorded_at": "2026-03-30T15:00:00.020Z",
            "user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "provider_id": "apple_health",
            "device_id": "Apple Watch",
            "source_type": "ble",
            "channel": "imu",
            "activity_id": None,
            "activity_type": None,
            "scalar": None,
            "vector": "{0.012,0.138,-0.987}",
        }
        jsonschema.validate(instance=row, schema=contract_schema)

    def test_api_source_type_passes(self, contract_schema: dict[str, Any]) -> None:
        row: dict[str, Any] = {
            "recorded_at": "2026-03-30T15:00:00Z",
            "user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "provider_id": "intervals",
            "device_id": None,
            "source_type": "api",
            "channel": "power",
            "activity_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
            "activity_type": "cycling",
            "scalar": 250,
            "vector": None,
        }
        jsonschema.validate(instance=row, schema=contract_schema)

    def test_file_source_type_passes(self, contract_schema: dict[str, Any]) -> None:
        row: dict[str, Any] = {
            "recorded_at": "2026-03-30T15:00:00Z",
            "user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "provider_id": "garmin",
            "device_id": "Edge 540",
            "source_type": "file",
            "channel": "cadence",
            "activity_id": None,
            "activity_type": None,
            "scalar": 90,
            "vector": None,
        }
        jsonschema.validate(instance=row, schema=contract_schema)

    def test_invalid_source_type_fails(self, contract_schema: dict[str, Any]) -> None:
        row: dict[str, Any] = {
            "recorded_at": "2026-03-30T15:00:00Z",
            "user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "provider_id": "wahoo",
            "device_id": None,
            "source_type": "invalid_source",
            "channel": "heart_rate",
            "activity_id": None,
            "activity_type": "cycling",
            "scalar": 142,
            "vector": None,
        }
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(instance=row, schema=contract_schema)

    def test_missing_required_field_fails(self, contract_schema: dict[str, Any]) -> None:
        row: dict[str, Any] = {
            "recorded_at": "2026-03-30T15:00:00Z",
            # missing user_id and other required fields
        }
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(instance=row, schema=contract_schema)

    def test_extra_property_fails(self, contract_schema: dict[str, Any]) -> None:
        row: dict[str, Any] = {
            "recorded_at": "2026-03-30T15:00:00Z",
            "user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "provider_id": "wahoo",
            "device_id": None,
            "source_type": "ble",
            "channel": "heart_rate",
            "activity_id": None,
            "activity_type": "cycling",
            "scalar": 142,
            "vector": None,
            "extra_field": "should not be here",
        }
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(instance=row, schema=contract_schema)

    def test_empty_provider_id_fails(self, contract_schema: dict[str, Any]) -> None:
        row: dict[str, Any] = {
            "recorded_at": "2026-03-30T15:00:00Z",
            "user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "provider_id": "",
            "device_id": None,
            "source_type": "ble",
            "channel": "heart_rate",
            "activity_id": None,
            "activity_type": "cycling",
            "scalar": 142,
            "vector": None,
        }
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(instance=row, schema=contract_schema)

    def test_empty_channel_fails(self, contract_schema: dict[str, Any]) -> None:
        row: dict[str, Any] = {
            "recorded_at": "2026-03-30T15:00:00Z",
            "user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            "provider_id": "wahoo",
            "device_id": None,
            "source_type": "ble",
            "channel": "",
            "activity_id": None,
            "activity_type": "cycling",
            "scalar": 142,
            "vector": None,
        }
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(instance=row, schema=contract_schema)
