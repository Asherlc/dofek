"""Input integrity must precede training or evaluation."""

import pytest
from matching_helpers import dataset_input


def test_accepts_namespaced_records_and_canonicalizes_pair_order() -> None:
    from dofek_ml.matching_data import Dataset

    dataset = Dataset.model_validate(dataset_input())
    assert dataset.pairs[0].key == ("alpha:train-0", "beta:train-0")
    assert len(dataset.records_for("test")) == 6


@pytest.mark.parametrize(
    "failure",
    ["namespace", "duplicate", "leak", "group", "reference", "label", "coordinate", "self"],
)
def test_rejects_invalid_or_leaking_inputs(failure: str) -> None:
    from dofek_ml.matching_data import Dataset

    payload = dataset_input()
    if failure == "namespace":
        payload["records"][0]["id"] = "wrong:123"
    elif failure == "duplicate":
        payload["records"].append(payload["records"][0])
    elif failure == "leak":
        payload["pairs"][0]["right"] = "beta:test-0"
    elif failure == "group":
        payload["records"][-1]["entity_group"] = "train-0"
    elif failure == "reference":
        payload["pairs"][0]["right"] = "beta:missing"
    elif failure == "label":
        payload["labels"].append(
            {
                "left": "beta:train-0",
                "right": "alpha:train-0",
                "label": "different",
                "provenance": "conflict",
            }
        )
    elif failure == "coordinate":
        payload["records"][0]["latitude"] = 100
    else:
        payload["pairs"][0]["right"] = payload["pairs"][0]["left"]
    with pytest.raises(ValueError, match=".+"):
        Dataset.model_validate(payload)
