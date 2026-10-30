"""Splink 5 label-trained probabilistic linkage with train-only name frequencies."""

from pathlib import Path
from typing import TYPE_CHECKING, cast

if TYPE_CHECKING:
    from collections.abc import Callable

import pandas as pd
from splink import DuckDBAPI, Linker, SettingsCreator
from splink import comparison_library as comparisons

from dofek_ml.matching_artifacts import load_artifact, training_artifact
from dofek_ml.matching_data import Dataset, PairKey, Record, Split


def _row(record: Record) -> dict[str, str | float | None]:
    return {"unique_id": record.id, "source_dataset": record.provider, **record.fields()}


def train(dataset: Dataset, directory: Path, seed: int, prior: float) -> None:
    if not 0 < prior < 1:
        raise ValueError("The declared population match prior must be between zero and one")
    with training_artifact(dataset, directory, "splink", seed, {"prior": prior}) as (
        artifact,
        output,
    ):
        api = DuckDBAPI()
        frame = api.register(
            pd.DataFrame([_row(record) for record in artifact.records]),
            dataset_display_name="training",
        )
        settings = SettingsCreator(
            link_type="link_only",
            probability_two_random_records_match=prior,
            comparisons=[
                comparisons.ExactMatch("name").configure(term_frequency_adjustments=True),
                comparisons.ExactMatch("context"),
                comparisons.ExactMatch("kind"),
            ],
        )
        linker = Linker(frame, settings)
        linker.training.estimate_u_using_random_sampling(
            max_pairs=100_000, seed=seed, min_count_per_level=1
        )
        positives = pd.DataFrame(
            [
                {
                    "unique_id_l": label.left,
                    "unique_id_r": label.right,
                    "source_dataset_l": dataset.index[label.left].provider,
                    "source_dataset_r": dataset.index[label.right].provider,
                }
                for label in artifact.labels
                if label.label == "same"
            ]
        )
        api.register(positives, table_name="positive_labels")
        # Splink's public label-training method has no annotations in 5.0.
        fit_labels = cast("Callable[[str], None]", linker.training.estimate_m_from_pairwise_labels)
        fit_labels("positive_labels")
        model = linker.misc.save_model_to_json()
        api.duckdb_con.close()
        import json

        missing = [
            comparison["output_column_name"]
            for comparison in model["comparisons"]
            if any(
                not level.get("is_null_level")
                and ("m_probability" not in level or "u_probability" not in level)
                for level in comparison["comparison_levels"]
            )
        ]
        if missing:
            raise ValueError(
                f"Splink has unestimated comparison levels in {missing}; "
                "add training examples covering agreement and disagreement"
            )
        (output / "splink.json").write_text(json.dumps(model, indent=2, allow_nan=False))


def predict(dataset: Dataset, directory: Path, split: Split) -> dict[PairKey, float]:
    artifact = load_artifact(dataset, directory, "splink", split)
    api = DuckDBAPI()
    frame = api.register(
        pd.DataFrame([_row(record) for record in artifact.records]), dataset_display_name="training"
    )
    linker = Linker(frame, directory / "splink.json")
    linker.table_management.compute_tf_table("name")
    index = dataset.index
    result = {}
    for pair in dataset.pairs_for(split):
        scored = linker.inference.score_pair(_row(index[pair.left]), _row(index[pair.right]))
        result[pair.key] = float(scored.as_record_list()[0]["match_probability"])
    api.duckdb_con.close()
    return result
