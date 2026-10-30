"""Validated, split-isolated offline entity linkage inputs."""

from pathlib import Path
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

type Split = Literal["train", "validation", "test"]
type PairKey = tuple[str, str]


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Record(InputModel):
    id: str = Field(min_length=1)
    provider: str = Field(min_length=1)
    name: str = Field(min_length=1)
    context: str | None = None
    kind: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    entity_group: str = Field(min_length=1)
    split: Split

    @field_validator("id", "provider", "name", "entity_group", "context", "kind")
    @classmethod
    def nonblank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("Use null for missing fields, not blank strings")
        return value

    @model_validator(mode="after")
    def validate_record(self) -> Self:
        if ":" in self.provider or not self.id.startswith(f"{self.provider}:"):
            raise ValueError("Record ID must be namespaced by its provider")
        if self.id == f"{self.provider}:":
            raise ValueError("Provider external ID must not be empty")
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("Latitude and longitude must both be present or null")
        return self

    def fields(self) -> dict[str, str | float | None]:
        return {
            "name": self.name,
            "context": self.context,
            "kind": self.kind,
            "latitude": self.latitude,
            "longitude": self.longitude,
        }


class Pair(InputModel):
    left: str
    right: str

    @property
    def key(self) -> PairKey:
        return (self.left, self.right) if self.left < self.right else (self.right, self.left)


class Label(Pair):
    label: Literal["same", "different", "unresolved"]
    provenance: str = Field(min_length=1)


class Dataset(InputModel):
    domain: str = Field(min_length=1)
    relationship: str = Field(min_length=1)
    records: list[Record] = Field(min_length=1)
    pairs: list[Pair]
    labels: list[Label]

    @classmethod
    def load(cls, path: Path) -> Self:
        return cls.model_validate_json(path.read_text())

    @property
    def index(self) -> dict[str, Record]:
        return {record.id: record for record in self.records}

    def records_for(self, split: Split) -> list[Record]:
        return [record for record in self.records if record.split == split]

    def pairs_for(self, split: Split) -> list[Pair]:
        index = self.index
        return [pair for pair in self.pairs if index[pair.left].split == split]

    def labels_for(self, split: Split) -> list[Label]:
        index = self.index
        return [label for label in self.labels if index[label.left].split == split]

    @model_validator(mode="after")
    def validate_dataset(self) -> Self:
        index = self.index
        if len(index) != len(self.records):
            raise ValueError("Duplicate record IDs")
        groups: dict[str, Split] = {}
        for record in self.records:
            if groups.setdefault(record.entity_group, record.split) != record.split:
                raise ValueError("Entity groups must not leak across splits")
        for pair in [*self.pairs, *self.labels]:
            if pair.left not in index or pair.right not in index:
                raise ValueError("Pair references an unknown record")
            left, right = index[pair.left], index[pair.right]
            if left.provider == right.provider:
                raise ValueError("Pairs must connect distinct providers, not self-pairs")
            if left.split != right.split:
                raise ValueError("Pair records must not cross splits")
        if len({pair.key for pair in self.pairs}) != len(self.pairs):
            raise ValueError("Duplicate candidate pairs, including reversed pairs")
        if len({label.key for label in self.labels}) != len(self.labels):
            raise ValueError("Duplicate or conflicting pair labels")
        for label in self.labels:
            if (
                label.label == "same"
                and index[label.left].entity_group != index[label.right].entity_group
            ):
                raise ValueError("Same-entity labels require a shared entity group")
        return self

    def training_labels(self) -> list[Label]:
        labels = [label for label in self.labels_for("train") if label.label != "unresolved"]
        if {label.label for label in labels} != {"same", "different"}:
            raise ValueError("Training requires both same and different labels")
        return labels
