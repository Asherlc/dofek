"""Hand-counted retrieval and classifier outcomes."""

import pytest
from matching_helpers import dataset_input


def test_reports_retrieval_misses_separately_from_abstentions_and_false_merges() -> None:
    from dofek_ml.matching_data import Dataset
    from dofek_ml.matching_metrics import evaluate

    payload = dataset_input()
    payload["pairs"] = [pair for pair in payload["pairs"] if pair["left"] != "alpha:test-2"]
    dataset = Dataset.model_validate(payload)
    scores = {
        ("alpha:test-0", "beta:test-0"): 0.9,
        ("alpha:test-1", "beta:test-1"): 0.5,
        ("alpha:test-0", "beta:test-1"): 0.95,
    }
    report = evaluate(dataset, scores, "test", 0.2, 0.8)
    assert report["counts"] == {
        "labeled": 4,
        "positives": 3,
        "true_matches": 1,
        "false_merges": 1,
        "missed_matches": 2,
        "retrieval_misses": 1,
        "abstentions": 1,
        "unresolved_labels": 0,
        "unlabeled_candidates": 0,
    }
    assert report["candidate_recall"] == pytest.approx(2 / 3)
    assert report["precision"] == 0.5
    assert report["recall"] == pytest.approx(1 / 3)
    assert len(report["disagreements"]) == 3
    assert report["by_source_pair"]['["alpha","beta"]']["false_merges"] == 1


def test_unresolved_truth_and_undefined_rates_are_not_negative_examples() -> None:
    from dofek_ml.matching_data import Dataset
    from dofek_ml.matching_metrics import evaluate

    payload = dataset_input()
    for label in payload["labels"]:
        label["label"] = "unresolved"
    report = evaluate(Dataset.model_validate(payload), {}, "test", 0.2, 0.8)
    assert report["precision"] is None
    assert report["recall"] is None
    assert report["candidate_recall"] is None
    assert report["counts"]["unresolved_labels"] == 4


def test_unlabeled_candidate_abstentions_are_counted_in_their_source_pair() -> None:
    from dofek_ml.matching_data import Dataset
    from dofek_ml.matching_metrics import evaluate

    payload = dataset_input()
    payload["labels"] = [label for label in payload["labels"] if label["left"] != "alpha:test-2"]
    result = evaluate(Dataset.model_validate(payload), {}, "test", 0.2, 0.8)
    assert result["counts"]["unlabeled_candidates"] == 1
    assert result["counts"]["abstentions"] == 4
    assert result["by_source_pair"]['["alpha","beta"]']["unlabeled_candidates"] == 1


def test_source_pair_counts_cannot_collide_when_provider_names_contain_delimiters() -> None:
    from dofek_ml.matching_data import Dataset
    from dofek_ml.matching_metrics import evaluate

    records = [
        {
            "id": f"{provider}:record",
            "provider": provider,
            "name": "Climb",
            "entity_group": f"group-{index}",
            "split": "test",
        }
        for index, provider in enumerate(("a / b", "c", "a", "b / c"))
    ]
    pairs = [
        {"left": "a / b:record", "right": "c:record"},
        {"left": "a:record", "right": "b / c:record"},
    ]
    dataset = Dataset.model_validate(
        {
            "domain": "climbing",
            "relationship": "catalogue_identity",
            "records": records,
            "pairs": pairs,
            "labels": [{**pair, "label": "different", "provenance": "synthetic"} for pair in pairs],
        }
    )
    report = evaluate(
        dataset, {dataset.pairs[0].key: 0.9, dataset.pairs[1].key: 0.1}, "test", 0.2, 0.8
    )
    assert len(report["by_source_pair"]) == 2
    assert sorted(values["false_merges"] for values in report["by_source_pair"].values()) == [0, 1]


@pytest.mark.parametrize(
    ("lower", "upper", "score"), [(0.8, 0.2, 0.5), (0.2, 0.8, float("nan")), (0.2, 0.8, 2.0)]
)
def test_rejects_invalid_thresholds_and_scores(lower: float, upper: float, score: float) -> None:
    from dofek_ml.matching_data import Dataset
    from dofek_ml.matching_metrics import evaluate

    with pytest.raises(ValueError, match=".+"):
        evaluate(
            Dataset.model_validate(dataset_input()),
            {("alpha:test-0", "beta:test-0"): score},
            "test",
            lower,
            upper,
        )
