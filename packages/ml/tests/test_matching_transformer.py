"""Real tiny local transformer: fine-tuning and safe save/load without network."""

import json
from pathlib import Path
from typing import TYPE_CHECKING, cast

if TYPE_CHECKING:
    from collections.abc import Callable

import pytest
import torch
from matching_helpers import dataset_input
from transformers import BertConfig, BertForSequenceClassification, BertTokenizer


def test_finetunes_local_model_and_preserves_label_order(tmp_path: Path) -> None:
    from dofek_ml.matching_data import Dataset
    from dofek_ml.matching_transformer import predict, train

    source = tmp_path / "source"
    source.mkdir()
    vocab = source / "vocab.txt"
    vocab.write_text(
        "\n".join(
            [
                "[PAD]",
                "[UNK]",
                "[CLS]",
                "[SEP]",
                "[MASK]",
                "name",
                "context",
                "kind",
                "route",
                "swiss",
                "cheese",
                "goat",
                "corner",
                "north",
                "crack",
                "area",
                "0",
                "1",
                "2",
                ":",
                "granite",
                "roof",
                "sandstone",
                "edge",
                "basalt",
                "slab",
                "train",
                "test",
                "validation",
                "birch",
                "oak",
                "elm",
            ]
        )
    )
    tokenizer = BertTokenizer(vocab=str(vocab), do_lower_case=True)
    tokenizer.save_pretrained(source)
    torch.manual_seed(1)
    build_model = cast(
        "Callable[[BertConfig], BertForSequenceClassification]", BertForSequenceClassification
    )
    model = build_model(
        BertConfig(
            vocab_size=len(tokenizer),
            hidden_size=16,
            num_hidden_layers=1,
            num_attention_heads=2,
            intermediate_size=24,
            id2label={0: "different", 1: "same"},
            label2id={"different": 0, "same": 1},
        )
    )
    before = model.classifier.weight.detach().clone()
    model.save_pretrained(source, safe_serialization=True, max_shard_size="1KB")
    dataset = Dataset.model_validate(dataset_input())
    train(dataset, tmp_path / "trained", source, seed=1, epochs=2, learning_rate=0.001)
    trained = BertForSequenceClassification.from_pretrained(
        tmp_path / "trained", local_files_only=True
    )
    assert not torch.equal(before, trained.classifier.weight)
    scores = predict(dataset, tmp_path / "trained", "test")
    assert len(scores) == 4
    assert all(0 <= score <= 1 for score in scores.values())
    assert scores == predict(dataset, tmp_path / "trained", "test")
    reversed_input = dataset_input()
    for pair in reversed_input["pairs"]:
        pair["left"], pair["right"] = pair["right"], pair["left"]
    assert scores == predict(Dataset.model_validate(reversed_input), tmp_path / "trained", "test")
    metrics = json.loads((tmp_path / "trained" / "training.json").read_text())
    assert len(metrics["epochs"]) == 2
    assert metrics["epochs"][0]["validation_loss"] > 0
    provenance = json.loads((tmp_path / "trained" / "metadata.json").read_text())
    assert len(provenance["parameters"]["source_weights_sha256"]) == 64
    from dofek_ml.matching_artifacts import seal_artifact

    # A real model with a controlled classifier head isolates class selection from fit quality.
    with torch.no_grad():
        trained.classifier.weight.zero_()
        trained.classifier.bias.copy_(torch.tensor([0.0, 2.0]))
    trained.save_pretrained(tmp_path / "trained", safe_serialization=True)
    seal_artifact(tmp_path / "trained")
    selected = predict(dataset, tmp_path / "trained", "test")
    assert all(score == pytest.approx(0.880797, abs=1e-6) for score in selected.values())
    trained.config.id2label = {0: "same", 1: "different"}
    trained.save_pretrained(tmp_path / "trained", safe_serialization=True)
    seal_artifact(tmp_path / "trained")
    with pytest.raises(ValueError, match="label order"):
        predict(dataset, tmp_path / "trained", "test")
    unsafe = tmp_path / "unsafe-source"
    tokenizer.save_pretrained(unsafe)
    model.config.save_pretrained(unsafe)
    torch.save(model.state_dict(), unsafe / "pytorch_model.bin")
    with pytest.raises(OSError, match="safetensors"):
        train(dataset, tmp_path / "unsafe-trained", unsafe, seed=1, epochs=1)
