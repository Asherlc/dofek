"""Exercise actual probabilistic fitting and persisted inference."""

from pathlib import Path

import pytest
from matching_helpers import dataset_input, with_same_name_negative


def test_splink_trains_and_reloads_without_using_held_out_frequencies(tmp_path: Path) -> None:
    from dofek_ml.matching_data import Dataset
    from dofek_ml.matching_splink import predict, train

    dataset = Dataset.model_validate(with_same_name_negative(dataset_input()))
    train(dataset, tmp_path / "model", seed=42, prior=0.1)
    scores = predict(dataset, tmp_path / "model", "test")
    assert scores[("alpha:test-0", "beta:test-0")] > scores[("alpha:test-0", "beta:test-1")]
    assert scores[("alpha:test-0", "beta:test-0")] > scores[("alpha:test-0", "beta:test-namesake")]
    assert scores == predict(dataset, tmp_path / "model", "test")
    assert (tmp_path / "model" / "metadata.json").exists()
    perturbed = dataset.model_dump()
    for index in range(20):
        perturbed["records"].append(
            {
                **perturbed["records"][0],
                "id": f"beta:test-frequency-{index}",
                "provider": "beta",
                "name": "Granite Roof",
                "split": "test",
                "entity_group": f"test-frequency-{index}",
            }
        )
    assert predict(Dataset.model_validate(perturbed), tmp_path / "model", "test") == scores


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
    train(Dataset.model_validate(dataset_input()), tmp_path / "model", seed=42, prior=0.1)
