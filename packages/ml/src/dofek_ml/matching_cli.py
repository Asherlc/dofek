"""Offline matching commands. All data and models remain caller-owned local files."""

import argparse
import hashlib
import json
import re
from pathlib import Path

from pydantic import Field

from dofek_ml.matching_artifacts import Artifact, fingerprint
from dofek_ml.matching_data import Dataset, InputModel, Pair, Split
from dofek_ml.matching_metrics import evaluate


class Score(Pair):
    score: float = Field(ge=0, le=1)


class Predictions(InputModel):
    engine: str
    engine_version: str
    seed: int
    split: Split
    dataset_sha256: str
    artifact_sha256: str
    parameters: dict[str, str | int | float]
    scores: list[Score]


def _digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _write(path: Path, result: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")


def main(arguments: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    acquire = commands.add_parser(
        "acquire", help="Explicitly download a revision-pinned pretrained model"
    )
    acquire.add_argument("model_id")
    acquire.add_argument("revision", help="Full 40-character commit SHA")
    acquire.add_argument("output", type=Path)
    training = commands.add_parser("train")
    training.add_argument("engine", choices=("splink", "dedupe", "transformer"))
    training.add_argument("dataset", type=Path)
    training.add_argument("model", type=Path)
    training.add_argument("--seed", type=int, default=42)
    training.add_argument(
        "--prior", type=float, help="Splink population match prior, not labeled class balance"
    )
    training.add_argument(
        "--pretrained", type=Path, help="Local safe-tensor checkpoint for transformer"
    )
    training.add_argument("--epochs", type=int, default=3)
    prediction = commands.add_parser("predict")
    prediction.add_argument("engine", choices=("splink", "dedupe", "transformer"))
    prediction.add_argument("dataset", type=Path)
    prediction.add_argument(
        "model", type=Path, help="Trusted local artifact; Dedupe settings use pickle"
    )
    prediction.add_argument("output", type=Path)
    prediction.add_argument("--split", choices=("validation", "test"), default="test")
    evaluation = commands.add_parser("evaluate")
    evaluation.add_argument("dataset", type=Path)
    evaluation.add_argument("predictions", type=Path)
    evaluation.add_argument("output", type=Path)
    evaluation.add_argument("--lower", type=float, required=True)
    evaluation.add_argument("--upper", type=float, required=True)
    queue = commands.add_parser("uncertain", help="Dedupe's next training pair to label")
    queue.add_argument("dataset", type=Path)
    queue.add_argument("model", type=Path)
    queue.add_argument("output", type=Path)
    mapping = commands.add_parser("map")
    mapping.add_argument("trace", type=Path)
    mapping.add_argument("output", type=Path)
    args = parser.parse_args(arguments)
    if args.command == "acquire":
        from huggingface_hub import snapshot_download

        if not re.fullmatch(r"[a-f0-9]{40}", args.revision):
            parser.error("Pretrained acquisition requires a full commit SHA")
        if args.output.exists():
            parser.error("Acquisition output must be a new directory")
        snapshot_download(
            args.model_id,
            revision=args.revision,
            local_dir=args.output,
            allow_patterns=[
                "config.json",
                "model.safetensors",
                "tokenizer.json",
                "tokenizer_config.json",
                "special_tokens_map.json",
                "vocab.txt",
            ],
        )
        _write(args.output / "source.json", {"model_id": args.model_id, "revision": args.revision})
        return
    if args.command == "map":
        from dofek_ml.matching_map import Trace, match_trace

        _write(args.output, match_trace(Trace.model_validate_json(args.trace.read_text())))
        return
    dataset = Dataset.load(args.dataset)
    if args.command == "train":
        if args.engine == "splink":
            from dofek_ml.matching_splink import train

            if args.prior is None:
                parser.error("Splink training requires --prior")
            train(dataset, args.model, args.seed, args.prior)
        elif args.engine == "dedupe":
            from dofek_ml import matching_dedupe

            matching_dedupe.train(dataset, args.model, args.seed)
        else:
            from dofek_ml import matching_transformer

            if args.pretrained is None:
                parser.error("Transformer training requires --pretrained")
            matching_transformer.train(dataset, args.model, args.pretrained, args.seed, args.epochs)
        return
    if args.command == "uncertain":
        from dofek_ml.matching_dedupe import uncertain

        _write(
            args.output,
            {
                "pairs_to_label": uncertain(dataset, args.model),
                "instructions": (
                    "Add same/different/unresolved with provenance to dataset labels; "
                    "train a new artifact."
                ),
            },
        )
        return
    if args.command == "predict":
        from dofek_ml import matching_dedupe, matching_splink, matching_transformer

        engines = {
            "splink": matching_splink,
            "dedupe": matching_dedupe,
            "transformer": matching_transformer,
        }
        scores = engines[args.engine].predict(dataset, args.model, args.split)
        metadata_path = args.model / "metadata.json"
        artifact = Artifact.model_validate_json(metadata_path.read_text())
        _write(
            args.output,
            Predictions(
                engine=artifact.engine,
                engine_version=artifact.engine_version,
                seed=artifact.seed,
                split=args.split,
                dataset_sha256=_digest(args.dataset),
                artifact_sha256=fingerprint(args.model),
                parameters=artifact.parameters,
                scores=[
                    Score(left=key[0], right=key[1], score=value) for key, value in scores.items()
                ],
            ).model_dump(),
        )
        return
    predictions = Predictions.model_validate_json(args.predictions.read_text())
    if predictions.dataset_sha256 != _digest(args.dataset):
        raise ValueError("Prediction dataset fingerprint differs from evaluation input")
    if len({score.key for score in predictions.scores}) != len(predictions.scores):
        raise ValueError("Duplicate prediction pairs")
    report: dict[str, object] = dict(
        evaluate(
            dataset,
            {score.key: score.score for score in predictions.scores},
            predictions.split,
            args.lower,
            args.upper,
        )
    )
    report.update(predictions.model_dump(exclude={"scores"}))
    _write(args.output, report)


if __name__ == "__main__":
    main()
