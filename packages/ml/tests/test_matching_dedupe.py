"""Exercise Dedupe's learned linkage and uncertain-pair workflow."""

from pathlib import Path

import pytest
from matching_helpers import learning_input, with_same_name_negative


def test_dedupe_trains_reloads_and_proposes_unlabeled_training_pairs(tmp_path: Path) -> None:
    from dofek_ml.matching_data import Dataset
    from dofek_ml.matching_dedupe import predict, train, uncertain

    dataset = Dataset.model_validate(with_same_name_negative(learning_input()))
    train(dataset, tmp_path / "model", seed=42)
    scores = predict(dataset, tmp_path / "model", "test")
    assert scores[("alpha:test-0", "beta:test-0")] > scores[("alpha:test-0", "beta:test-1")]
    assert scores[("alpha:test-0", "beta:test-0")] > scores[("alpha:test-0", "beta:test-namesake")]
    assert scores == predict(dataset, tmp_path / "model", "test")
    queue = uncertain(dataset, tmp_path / "model")
    labeled = {label.key for label in dataset.labels_for("train") if label.label != "unresolved"}
    assert queue
    assert all(tuple(sorted((pair["left"], pair["right"]))) not in labeled for pair in queue)
    assert all("train" in pair["left"] and "train" in pair["right"] for pair in queue)
    payload = learning_input()
    payload["labels"].append(
        {**queue[0], "label": "different", "provenance": "human fixture review"}
    )
    updated = Dataset.model_validate(payload)
    train(updated, tmp_path / "updated", seed=42)
    assert queue[0] not in uncertain(updated, tmp_path / "updated")


def test_exhausted_active_learning_queue_returns_no_pair(tmp_path: Path) -> None:
    from dofek_ml.matching_data import Dataset
    from dofek_ml.matching_dedupe import train, uncertain

    payload = learning_input()
    known = {(label["left"], label["right"]) for label in payload["labels"]}
    for left in range(15):
        for right in range(15):
            pair = (f"alpha:train-{left}", f"beta:train-{right}")
            if pair not in known:
                payload["labels"].append(
                    {
                        "left": pair[0],
                        "right": pair[1],
                        "label": "same" if left == right else "different",
                        "provenance": "complete fixture labels",
                    }
                )
    dataset = Dataset.model_validate(payload)
    train(dataset, tmp_path / "model", seed=42)
    assert uncertain(dataset, tmp_path / "model") == []


def test_active_learning_rejects_changed_training_population(tmp_path: Path) -> None:
    from dofek_ml.matching_data import Dataset
    from dofek_ml.matching_dedupe import train, uncertain

    payload = learning_input()
    train(Dataset.model_validate(payload), tmp_path / "model", seed=42)
    new_record = {
        **payload["records"][0],
        "id": "alpha:fresh",
        "entity_group": "fresh-training-entity",
    }
    payload["records"].append(new_record)
    with pytest.raises(ValueError, match="Training.*changed"):
        uncertain(Dataset.model_validate(payload), tmp_path / "model")
