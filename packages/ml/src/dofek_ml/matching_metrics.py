"""Separate candidate retrieval coverage from pair-classification outcomes."""

import math
from typing import TypedDict

from dofek_ml.matching_data import Dataset, PairKey, Split


class Evaluation(TypedDict):
    domain: str
    relationship: str
    split: Split
    thresholds: dict[str, float]
    counts: dict[str, int]
    candidate_recall: float | None
    precision: float | None
    recall: float | None
    by_source_pair: dict[str, dict[str, int]]
    disagreements: list[dict[str, object]]
    decisions: list[dict[str, object]]
    score_interpretation: str


def evaluate(
    dataset: Dataset, predictions: dict[PairKey, float], split: Split, lower: float, upper: float
) -> Evaluation:
    if not 0 <= lower < upper <= 1:
        raise ValueError("Thresholds must satisfy 0 <= lower < upper <= 1")
    candidates = {pair.key for pair in dataset.pairs_for(split)}
    for key, prediction in predictions.items():
        if key not in candidates or not math.isfinite(prediction) or not 0 <= prediction <= 1:
            raise ValueError("Scores must be finite [0, 1] values for supplied candidates")
    labels = dataset.labels_for(split)
    index = dataset.index
    counts = dict.fromkeys(
        (
            "labeled",
            "positives",
            "true_matches",
            "false_merges",
            "missed_matches",
            "retrieval_misses",
            "abstentions",
            "unresolved_labels",
            "unlabeled_candidates",
        ),
        0,
    )
    by_source: dict[str, dict[str, int]] = {}
    disagreements: list[dict[str, object]] = []
    known_keys = {label.key for label in labels}
    counts["unlabeled_candidates"] = len(candidates - known_keys)
    for label in labels:
        source = " / ".join(sorted((index[label.left].provider, index[label.right].provider)))
        source_counts = by_source.setdefault(source, dict.fromkeys(counts, 0))
        score = predictions.get(label.key)
        retrieved = label.key in candidates
        decision = (
            "unresolved"
            if score is None
            else "same"
            if score >= upper
            else "different"
            if score <= lower
            else "unresolved"
        )
        increments = {
            "labeled": int(label.label != "unresolved"),
            "positives": int(label.label == "same"),
            "true_matches": int(label.label == "same" and decision == "same"),
            "false_merges": int(label.label == "different" and decision == "same"),
            "missed_matches": int(label.label == "same" and decision != "same"),
            "retrieval_misses": int(label.label == "same" and not retrieved),
            "abstentions": int(retrieved and decision == "unresolved"),
            "unresolved_labels": int(label.label == "unresolved"),
        }
        for name, value in increments.items():
            counts[name] += value
            source_counts[name] += value
        if label.label != "unresolved" and decision != label.label:
            disagreements.append(
                {
                    "left": label.left,
                    "right": label.right,
                    "expected": label.label,
                    "decision": decision,
                    "retrieved": retrieved,
                    "score": score,
                }
            )
    positives = counts["positives"]
    predicted_matches = counts["true_matches"] + counts["false_merges"]
    counts["abstentions"] = 0
    for values in by_source.values():
        values["abstentions"] = 0
    decisions: list[dict[str, object]] = []
    for pair in dataset.pairs_for(split):
        source = " / ".join(sorted((index[pair.left].provider, index[pair.right].provider)))
        source_counts = by_source.setdefault(source, dict.fromkeys(counts, 0))
        score = predictions.get(pair.key)
        decision = (
            "unresolved"
            if score is None
            else "same"
            if score >= upper
            else "different"
            if score <= lower
            else "unresolved"
        )
        counts["abstentions"] += int(decision == "unresolved")
        source_counts["abstentions"] += int(decision == "unresolved")
        source_counts["unlabeled_candidates"] += int(pair.key not in known_keys)
        decisions.append(
            {
                "left": pair.key[0],
                "right": pair.key[1],
                "score": score,
                "decision": decision,
                "observed_fields": {key: index[key].fields() for key in pair.key},
            }
        )
    return {
        "domain": dataset.domain,
        "relationship": dataset.relationship,
        "split": split,
        "thresholds": {"lower": lower, "upper": upper},
        "counts": counts,
        "candidate_recall": (positives - counts["retrieval_misses"]) / positives
        if positives
        else None,
        "precision": counts["true_matches"] / predicted_matches if predicted_matches else None,
        "recall": counts["true_matches"] / positives if positives else None,
        "by_source_pair": by_source,
        "disagreements": disagreements,
        "decisions": decisions,
        "score_interpretation": "Model scores are not calibrated probabilities.",
    }
