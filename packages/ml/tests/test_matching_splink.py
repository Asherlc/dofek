"""Exercise actual probabilistic fitting and persisted inference."""

from pathlib import Path

import pytest
from matching_helpers import dataset_input


def test_splink_trains_and_reloads_without_using_held_out_frequencies(tmp_path: Path) -> None:
    from dofek_ml.matching_data import Dataset
    from dofek_ml.matching_splink import predict, train

    dataset = Dataset.model_validate(dataset_input())
    train(dataset, tmp_path / "model", seed=42, prior=0.1)
    scores = predict(dataset, tmp_path / "model", "test")
    assert scores[("alpha:test-0", "beta:test-0")] > scores[("alpha:test-0", "beta:test-1")]
    assert scores == predict(dataset, tmp_path / "model", "test")
    assert (tmp_path / "model" / "metadata.json").exists()


def test_splink_rejects_training_that_leaves_comparison_parameters_unestimated(
    tmp_path: Path,
) -> None:
    from dofek_ml.matching_data import Dataset
    from dofek_ml.matching_splink import train

    payload = dataset_input()
    for record in payload["records"]:
        record["kind"] = "route"
    with pytest.raises(ValueError, match="unestimated"):
        train(Dataset.model_validate(payload), tmp_path / "model", seed=42, prior=0.1)
