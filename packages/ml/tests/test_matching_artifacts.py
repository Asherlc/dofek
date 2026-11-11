"""Saved model identity and held-out leakage checks."""

import json
from pathlib import Path

import pytest
from matching_helpers import dataset_input

from dofek_ml.matching_artifacts import create_artifact, load_artifact
from dofek_ml.matching_data import Dataset


def test_model_provenance_rejects_cross_domain_and_training_overlap(tmp_path: Path) -> None:
    dataset = Dataset.model_validate(dataset_input())
    artifact = create_artifact(dataset, tmp_path / "model", "splink", 42)
    assert len(artifact.training_sha256) == 64
    assert len(artifact.records) == 6
    payload = dataset_input()
    payload["relationship"] = "activity_occurrence"
    with pytest.raises(ValueError, match="relationship"):
        load_artifact(Dataset.model_validate(payload), tmp_path / "model", "splink", "test")
    payload = dataset_input()
    payload["records"] = [record for record in payload["records"] if record["split"] == "train"]
    for record in payload["records"]:
        record["split"] = "test"
    payload["pairs"], payload["labels"] = [], []
    with pytest.raises(ValueError, match="overlap"):
        load_artifact(Dataset.model_validate(payload), tmp_path / "model", "splink", "test")


def test_model_provenance_requires_the_recorded_library_version(tmp_path: Path) -> None:
    dataset = Dataset.model_validate(dataset_input())
    create_artifact(dataset, tmp_path / "model", "splink", 42)
    path = tmp_path / "model" / "metadata.json"
    saved = json.loads(path.read_text())
    saved["engine_version"] = "wrong-version"
    path.write_text(json.dumps(saved))
    with pytest.raises(ValueError, match="version"):
        load_artifact(dataset, tmp_path / "model", "splink", "test")


def test_manifest_detects_changed_model_content_and_missing_weights(tmp_path: Path) -> None:
    from dofek_ml.matching_artifacts import fingerprint, seal_artifact

    dataset = Dataset.model_validate(dataset_input())
    create_artifact(dataset, tmp_path / "model", "splink", 42)
    weights = tmp_path / "model" / "splink.json"
    weights.write_text('{"model": "first"}')
    seal_artifact(tmp_path / "model")
    initial = fingerprint(tmp_path / "model")
    load_artifact(dataset, tmp_path / "model", "splink", "test")
    unexpected = tmp_path / "model" / "added_tokens.json"
    unexpected.write_text('{"changed-token": 17}')
    with pytest.raises(ValueError, match="fingerprint"):
        load_artifact(dataset, tmp_path / "model", "splink", "test")
    unexpected.unlink()
    weights.write_text('{"model": "changed"}')
    with pytest.raises(ValueError, match="fingerprint"):
        load_artifact(dataset, tmp_path / "model", "splink", "test")
    seal_artifact(tmp_path / "model")
    assert fingerprint(tmp_path / "model") != initial
    weights.unlink()
    with pytest.raises(ValueError, match="fingerprint"):
        load_artifact(dataset, tmp_path / "model", "splink", "test")
