"""Synthetic catalogue datasets shared by matching tests."""

from typing import Any


def dataset_input() -> dict[str, Any]:
    """Three independent entities per split, each observed by two providers."""
    records = []
    pairs = []
    labels = []
    names = {
        "train": ("Swiss Cheese", "Goat Corner", "North Crack"),
        "validation": ("Birch Slab", "Oak Corner", "Elm Crack"),
        "test": ("Granite Roof", "Sandstone Edge", "Basalt Slab"),
    }
    for split in ("train", "validation", "test"):
        for index, name in enumerate(names[split]):
            for provider in ("alpha", "beta"):
                records.append(
                    {
                        "id": f"{provider}:{split}-{index}",
                        "provider": provider,
                        "name": f"{name} alias"
                        if split == "train" and index == 1 and provider == "beta"
                        else name,
                        "context": f"Area {split} {index}"
                        + (
                            " lower wall"
                            if split == "train" and index == 1 and provider == "beta"
                            else ""
                        ),
                        "kind": "boulder"
                        if split == "train" and index == 1 and provider == "beta"
                        else "route",
                        "entity_group": f"{split}-{index}",
                        "split": split,
                    }
                )
            pairs.append({"left": f"alpha:{split}-{index}", "right": f"beta:{split}-{index}"})
            labels.append({**pairs[-1], "label": "same", "provenance": "synthetic fixture"})
        pairs.append({"left": f"alpha:{split}-0", "right": f"beta:{split}-1"})
        labels.append({**pairs[-1], "label": "different", "provenance": "synthetic fixture"})
    return {
        "domain": "climbing",
        "relationship": "catalogue_identity",
        "records": records,
        "pairs": pairs,
        "labels": labels,
    }


def learning_input() -> dict[str, Any]:
    """Enough positive and negative labels for Dedupe's five-fold fitting."""
    payload = dataset_input()
    for index in range(3, 15):
        for provider in ("alpha", "beta"):
            payload["records"].append(
                {
                    "id": f"{provider}:train-{index}",
                    "provider": provider,
                    "name": f"Granite {index} Arete",
                    "context": f"Wall {index}",
                    "kind": "route",
                    "entity_group": f"train-{index}",
                    "split": "train",
                }
            )
        same = {"left": f"alpha:train-{index}", "right": f"beta:train-{index}"}
        different = {"left": f"alpha:train-{index}", "right": "beta:train-0"}
        payload["pairs"].extend([same, different])
        payload["labels"].extend(
            [
                {**same, "label": "same", "provenance": "synthetic fixture"},
                {**different, "label": "different", "provenance": "synthetic fixture"},
            ]
        )
    return payload


def with_same_name_negative(payload: dict[str, Any]) -> dict[str, Any]:
    """A separate climb with an identical name and conflicting area context."""
    original = next(record for record in payload["records"] if record["id"] == "alpha:test-0")
    payload["records"].append(
        {
            **original,
            "id": "beta:test-namesake",
            "provider": "beta",
            "context": "Independent canyon",
            "entity_group": "test-namesake",
        }
    )
    pair = {"left": "alpha:test-0", "right": "beta:test-namesake"}
    payload["pairs"].append(pair)
    payload["labels"].append({**pair, "label": "different", "provenance": "synthetic namesake"})
    return payload
