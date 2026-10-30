"""Execute the user-facing offline commands rather than inspect their source."""

import json
import subprocess
import sys
from pathlib import Path

from matching_helpers import dataset_input

from dofek_ml.matching_cli import main


def run_cli(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "dofek_ml.matching_cli", *arguments],
        capture_output=True,
        text=True,
        check=False,
    )


def test_splink_cli_training_prediction_and_evaluation(tmp_path: Path) -> None:
    dataset = tmp_path / "dataset.json"
    dataset.write_text(json.dumps(dataset_input()))
    model = tmp_path / "model"
    scores = tmp_path / "predictions.json"
    report = tmp_path / "report.json"
    trained = run_cli("train", "splink", str(dataset), str(model), "--prior", "0.1")
    assert trained.returncode == 0, trained.stderr
    predicted = run_cli("predict", "splink", str(dataset), str(model), str(scores))
    assert predicted.returncode == 0, predicted.stderr
    main(["evaluate", str(dataset), str(scores), str(report), "--lower", "0.2", "--upper", "0.8"])
    result = json.loads(report.read_text())
    assert result["engine"] == "splink"
    assert result["counts"]["labeled"] == 4
    assert result["candidate_recall"] == 1
    assert len(result["dataset_sha256"]) == 64


def test_invalid_cli_input_exits_nonzero_without_a_success_report(tmp_path: Path) -> None:
    dataset = tmp_path / "invalid.json"
    dataset.write_text("{}")
    result = run_cli("train", "splink", str(dataset), str(tmp_path / "model"), "--prior", "0.1")
    assert result.returncode != 0
    assert "ValidationError" in result.stderr


def test_cli_map_executes_the_directed_graph_example(tmp_path: Path) -> None:
    source = Path(__file__).parents[1] / "examples/matching/trace.json"
    output = tmp_path / "map.json"
    main(["map", str(source), str(output)])
    report = json.loads(output.read_text())
    assert report["edges"] == [["a", "b"], ["b", "c"]]
    assert report["coverage"] == 1


def test_cli_dedupe_train_predict_and_label_queue(tmp_path: Path) -> None:
    from matching_helpers import learning_input

    dataset = tmp_path / "dataset.json"
    dataset.write_text(json.dumps(learning_input()))
    model, scores, queue = tmp_path / "model", tmp_path / "scores.json", tmp_path / "queue.json"
    main(["train", "dedupe", str(dataset), str(model)])
    main(["predict", "dedupe", str(dataset), str(model), str(scores)])
    main(["uncertain", str(dataset), str(model), str(queue)])
    assert len(json.loads(scores.read_text())["scores"]) == 4
    assert json.loads(queue.read_text())["pairs_to_label"]
