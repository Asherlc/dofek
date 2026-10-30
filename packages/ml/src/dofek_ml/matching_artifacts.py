"""Model provenance and leakage checks shared by offline engine consumers."""

import hashlib
import json
import re
from contextlib import contextmanager
from importlib.metadata import version
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterator

from pydantic import Field, field_validator

from dofek_ml.matching_data import Dataset, InputModel, Label, Record, Split


class PretrainedSource(InputModel):
    model_id: str = Field(min_length=1)
    revision: str = Field(pattern=r"^[a-f0-9]{40}$")


class Artifact(InputModel):
    engine: str
    engine_version: str
    domain: str
    relationship: str
    seed: int
    training_sha256: str
    records: list[Record]
    labels: list[Label]
    parameters: dict[str, str | int | float]


class Manifest(InputModel):
    files: dict[str, str] = Field(min_length=1)

    @field_validator("files")
    @classmethod
    def validate_files(cls, files: dict[str, str]) -> dict[str, str]:
        for name, digest in files.items():
            path = Path(name)
            if path.is_absolute() or ".." in path.parts or name == "manifest.json":
                raise ValueError("Model manifest paths must stay inside the artifact directory")
            if not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise ValueError("Model manifest requires SHA-256 file fingerprints")
        return files


def _training_sha256(records: list[Record], labels: list[Label]) -> str:
    content = "\n".join(
        [record.model_dump_json() for record in records]
        + [label.model_dump_json() for label in labels]
    )
    return hashlib.sha256(content.encode()).hexdigest()


@contextmanager
def new_artifact_directory(directory: Path) -> "Iterator[Path]":
    if directory.exists() or directory.is_symlink():
        raise FileExistsError(f"Artifact output already exists: {directory}")
    directory.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=f".{directory.name}-", dir=directory.parent) as temporary:
        output = Path(temporary) / "artifact"
        yield output
        if directory.exists() or directory.is_symlink():
            raise FileExistsError(f"Artifact output already exists: {directory}")
        output.rename(directory)


@contextmanager
def training_artifact(
    dataset: Dataset,
    directory: Path,
    engine: str,
    seed: int,
    parameters: dict[str, str | int | float] | None = None,
) -> "Iterator[tuple[Artifact, Path]]":
    with new_artifact_directory(directory) as output:
        artifact = create_artifact(dataset, output, engine, seed, parameters)
        yield artifact, output
        seal_artifact(output)


def _file_digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def seal_artifact(directory: Path) -> None:
    files = {
        path.relative_to(directory).as_posix(): _file_digest(path)
        for path in sorted(directory.rglob("*"))
        if path.is_file() and path.name != "manifest.json"
    }
    manifest = Manifest(files=files)
    (directory / "manifest.json").write_text(manifest.model_dump_json(indent=2))


def fingerprint(directory: Path) -> str:
    manifest = Manifest.model_validate_json((directory / "manifest.json").read_text())
    present = {
        path.relative_to(directory).as_posix()
        for path in directory.rglob("*")
        if path.is_file() and path.relative_to(directory).as_posix() != "manifest.json"
    }
    if present != manifest.files.keys():
        raise ValueError("Model file fingerprint mismatch: artifact file inventory changed")
    for name, expected in manifest.files.items():
        path = directory / name
        if not path.is_file() or path.is_symlink() or _file_digest(path) != expected:
            raise ValueError(f"Model file fingerprint mismatch: {name}")
    content = json.dumps(manifest.model_dump(), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(content.encode()).hexdigest()


def create_artifact(
    dataset: Dataset,
    directory: Path,
    engine: str,
    seed: int,
    parameters: dict[str, str | int | float] | None = None,
) -> Artifact:
    labels = dataset.training_labels()
    records = dataset.records_for("train")
    artifact = Artifact(
        engine=engine,
        engine_version=version(engine),
        domain=dataset.domain,
        relationship=dataset.relationship,
        seed=seed,
        training_sha256=_training_sha256(records, labels),
        records=records,
        labels=labels,
        parameters=parameters or {},
    )
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "metadata.json").write_text(artifact.model_dump_json(indent=2))
    return artifact


def load_artifact(dataset: Dataset, directory: Path, engine: str, split: Split) -> Artifact:
    artifact = Artifact.model_validate_json((directory / "metadata.json").read_text())
    if artifact.engine != engine or (artifact.domain, artifact.relationship) != (
        dataset.domain,
        dataset.relationship,
    ):
        raise ValueError("Model engine/domain/relationship does not match the dataset")
    if artifact.engine_version != version(engine):
        raise ValueError("Model library version differs; use its recorded locked environment")
    if (
        split == "train"
        and _training_sha256(dataset.records_for("train"), dataset.training_labels())
        != artifact.training_sha256
    ):
        raise ValueError("Training records or labels changed; train a new artifact")
    if split != "train":
        ids = {record.id for record in artifact.records}
        groups = {record.entity_group for record in artifact.records}
        if any(
            record.id in ids or record.entity_group in groups
            for record in dataset.records_for(split)
        ):
            raise ValueError("Inference records or entity groups overlap model training data")
    fingerprint(directory)
    return artifact
