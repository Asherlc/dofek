"""Local, safe-tensor text-pair fine-tuning and inference."""

import hashlib
import json
from pathlib import Path

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from dofek_ml.matching_artifacts import (
    PretrainedSource,
    load_artifact,
    training_artifact,
)
from dofek_ml.matching_data import Dataset, Pair, PairKey, Record, Split


def _text(record: Record) -> str:
    return "\n".join(
        f"{name}: {value}" for name, value in record.fields().items() if value is not None
    )


def _texts(dataset: Dataset, pairs: list[Pair]) -> tuple[list[str], list[str]]:
    index = dataset.index
    return (
        [_text(index[pair.key[0]]) for pair in pairs],
        [_text(index[pair.key[1]]) for pair in pairs],
    )


def train(
    dataset: Dataset,
    directory: Path,
    model_path: Path,
    seed: int,
    epochs: int = 3,
    learning_rate: float = 5e-5,
) -> None:
    if epochs < 1 or not 0 < learning_rate < 1:
        raise ValueError("Require positive epochs and a learning rate between zero and one")
    torch.manual_seed(seed)
    torch.set_num_threads(1)
    labels = dataset.training_labels()
    validation = [
        label for label in dataset.labels_for("validation") if label.label != "unresolved"
    ]
    if not validation:
        raise ValueError("Provide labeled validation pairs separate from training and test")
    tokenizer = AutoTokenizer.from_pretrained(
        model_path, local_files_only=True, trust_remote_code=False
    )
    model = AutoModelForSequenceClassification.from_pretrained(
        model_path,
        num_labels=2,
        local_files_only=True,
        trust_remote_code=False,
        use_safetensors=True,
    )
    model.config.id2label = {0: "different", 1: "same"}
    model.config.label2id = {"different": 0, "same": 1}
    weights_digest = hashlib.sha256()
    for weights in sorted(model_path.glob("*.safetensors")):
        with weights.open("rb") as source:
            weights_digest.update(weights.name.encode())
            weights_digest.update(hashlib.file_digest(source, "sha256").digest())
    parameters: dict[str, str | int | float] = {
        "model_path": str(model_path.resolve()),
        "epochs": epochs,
        "learning_rate": learning_rate,
        "max_length": 256,
        "source_weights_sha256": weights_digest.hexdigest(),
    }
    source_path = model_path / "source.json"
    if source_path.exists():
        pretrained_source = PretrainedSource.model_validate_json(source_path.read_text())
        parameters.update(pretrained_source.model_dump())
    with training_artifact(dataset, directory, "transformers", seed, parameters) as (_, output):
        optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate)
        history = []
        for epoch in range(epochs):
            model.train()
            total_loss = 0.0
            order = torch.randperm(len(labels)).tolist()
            for offset in range(0, len(order), 8):
                batch = [labels[position] for position in order[offset : offset + 8]]
                left, right = _texts(dataset, list(batch))
                tokens = tokenizer(
                    left, right, padding=True, truncation=True, max_length=256, return_tensors="pt"
                )
                target = torch.tensor([int(label.label == "same") for label in batch])
                optimizer.zero_grad()
                loss = model(**tokens, labels=target).loss
                loss.backward()
                optimizer.step()
                total_loss += float(loss.detach()) * len(batch)
            model.eval()
            validation_loss = 0.0
            with torch.no_grad():
                for offset in range(0, len(validation), 8):
                    batch = validation[offset : offset + 8]
                    left, right = _texts(dataset, list(batch))
                    tokens = tokenizer(
                        left,
                        right,
                        padding=True,
                        truncation=True,
                        max_length=256,
                        return_tensors="pt",
                    )
                    target = torch.tensor([int(label.label == "same") for label in batch])
                    validation_loss += float(model(**tokens, labels=target).loss) * len(batch)
            history.append(
                {
                    "epoch": epoch + 1,
                    "training_loss": total_loss / len(labels),
                    "validation_loss": validation_loss / len(validation),
                }
            )
        model.save_pretrained(output, safe_serialization=True)
        tokenizer.save_pretrained(output)
        (output / "training.json").write_text(json.dumps({"epochs": history}, indent=2))


def predict(dataset: Dataset, directory: Path, split: Split) -> dict[PairKey, float]:
    load_artifact(dataset, directory, "transformers", split)
    torch.set_num_threads(1)
    tokenizer = AutoTokenizer.from_pretrained(
        directory, local_files_only=True, trust_remote_code=False
    )
    model = AutoModelForSequenceClassification.from_pretrained(
        directory, local_files_only=True, trust_remote_code=False, use_safetensors=True
    )
    if model.config.id2label != {0: "different", 1: "same"}:
        raise ValueError("Model label order must be 0=different, 1=same")
    model.eval()
    pairs = dataset.pairs_for(split)
    scores = {}
    with torch.no_grad():
        for offset in range(0, len(pairs), 8):
            batch = pairs[offset : offset + 8]
            left, right = _texts(dataset, batch)
            tokens = tokenizer(
                left, right, padding=True, truncation=True, max_length=256, return_tensors="pt"
            )
            values = torch.softmax(model(**tokens).logits, dim=1)[:, 1].tolist()
            for pair, score in zip(batch, values, strict=True):
                scores[pair.key] = float(score)
    return scores
