"""Dedupe record linkage and its classifier/blocker disagreement label queue."""

import random
from collections.abc import Mapping, MutableSequence
from pathlib import Path
from typing import TypedDict

import dedupe
import numpy as np
from dedupe import variables

from dofek_ml.matching_artifacts import Artifact, create_artifact, load_artifact, seal_artifact
from dofek_ml.matching_data import Dataset, PairKey, Record, Split


class TrainingPairs(TypedDict):
    match: MutableSequence[tuple[Mapping[str, object], Mapping[str, object]]]
    distinct: MutableSequence[tuple[Mapping[str, object], Mapping[str, object]]]


def _row(record: Record) -> dict[str, str | None]:
    return {"id": record.id, "name": record.name, "context": record.context, "kind": record.kind}


def _learner(artifact: Artifact) -> dedupe.RecordLink:
    random.seed(artifact.seed)
    np.random.seed(artifact.seed)
    providers = sorted({record.provider for record in artifact.records})
    if len(providers) != 2:
        raise ValueError("Dedupe record linkage requires exactly two training providers")
    index = {record.id: record for record in artifact.records}
    left = {
        record.id: _row(record) for record in artifact.records if record.provider == providers[0]
    }
    right = {
        record.id: _row(record) for record in artifact.records if record.provider == providers[1]
    }
    matcher = dedupe.RecordLink(
        [
            variables.String("name"),
            variables.String("context", has_missing=True),
            variables.Exact("kind", has_missing=True),
        ],
        num_cores=0,
        in_memory=True,
    )
    matcher.prepare_training(left, right, sample_size=min(len(left) * len(right), 1500))
    marked: TrainingPairs = {
        "match": [],
        "distinct": [],
    }
    for label in artifact.labels:
        first, second = index[label.left], index[label.right]
        if first.provider != providers[0]:
            first, second = second, first
        marked["match" if label.label == "same" else "distinct"].append((_row(first), _row(second)))
    matcher.mark_pairs(marked)
    return matcher


def train(dataset: Dataset, directory: Path, seed: int) -> None:
    labels = dataset.training_labels()
    if any(
        sum(label.label == category for label in labels) < 5 for category in ("same", "different")
    ):
        raise ValueError(
            "Dedupe fitting requires at least five labels of each class for cross-validation"
        )
    artifact = create_artifact(dataset, directory, "dedupe", seed)
    matcher = _learner(artifact)
    matcher.train()
    with (directory / "dedupe.settings").open("wb") as output:
        matcher.write_settings(output)
    with (directory / "dedupe.training.json").open("w") as output:
        matcher.write_training(output)
    seal_artifact(directory)


def predict(dataset: Dataset, directory: Path, split: Split) -> dict[PairKey, float]:
    load_artifact(dataset, directory, "dedupe", split)
    index = dataset.index
    pairs = dataset.pairs_for(split)
    if not pairs:
        return {}
    with (directory / "dedupe.settings").open("rb") as source:
        matcher = dedupe.StaticRecordLink(source, num_cores=0, in_memory=True)
    rows = (
        ((pair.left, _row(index[pair.left])), (pair.right, _row(index[pair.right])))
        for pair in pairs
    )
    scored = matcher.score(rows)
    result = {}
    for row in scored:
        left, right = sorted(map(str, row["pairs"]))
        result[(left, right)] = float(row["score"])
    return result


def uncertain(dataset: Dataset, directory: Path) -> list[dict[str, str]]:
    artifact = load_artifact(dataset, directory, "dedupe", "train")
    current = dataset.training_labels()
    if [label.model_dump() for label in current] != [
        label.model_dump() for label in artifact.labels
    ]:
        raise ValueError("Labels changed: train a new artifact before requesting its next queue")
    matcher = _learner(artifact)
    known = {label.key for label in artifact.labels}
    learner = matcher.active_learner
    assert learner is not None, "Dedupe prepare_training must initialize its active learner"
    # The public learner exposes the remaining candidate population. Do not pop an empty queue.
    while len(learner) > 0:
        found = matcher.uncertain_pairs()
        left, right = str(found[0][0]["id"]), str(found[0][1]["id"])
        key = (left, right) if left < right else (right, left)
        if key not in known:
            return [{"left": left, "right": right}]
    return []
