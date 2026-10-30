"""Actual HMM behavior on a small directed WGS84 graph."""

from typing import Any

import pytest


def trace_input() -> dict[str, Any]:
    return {
        "provenance": "synthetic directed road",
        "nodes": [
            {"id": "a", "latitude": 37.0, "longitude": -122.0},
            {"id": "b", "latitude": 37.0, "longitude": -121.999},
            {"id": "c", "latitude": 37.0, "longitude": -121.998},
        ],
        "edges": [["a", "b"], ["b", "c"]],
        "observations": [
            {"latitude": 37.00001, "longitude": longitude, "timestamp": timestamp}
            for timestamp, longitude in enumerate(
                (-121.9999, -121.9996, -121.9991, -121.9987, -121.9981)
            )
        ],
        "expected_edges": [["a", "b"], ["b", "c"]],
    }


def test_matches_noisy_trace_with_directed_edges() -> None:
    from dofek_ml.matching_map import Trace, match_trace

    result = match_trace(Trace.model_validate(trace_input()))
    assert result["status"] == "complete"
    assert result["edges"] == [["a", "b"], ["b", "c"]]
    assert result["coverage"] == 1
    assert result["expected_edge_recall"] == 1
    assert result["path"] == ["a", "b", "c"]


def test_out_of_coverage_is_unresolved_not_a_complete_path() -> None:
    from dofek_ml.matching_map import Trace, match_trace

    payload = trace_input()
    payload["observations"][-1]["latitude"] = 38
    result = match_trace(Trace.model_validate(payload))
    assert result["status"] == "unresolved"
    assert result["coverage"] < 1


def test_reverse_trace_cannot_complete_against_a_one_way_graph() -> None:
    from dofek_ml.matching_map import Trace, match_trace

    payload = trace_input()
    payload["observations"].reverse()
    for timestamp, observation in enumerate(payload["observations"]):
        observation["timestamp"] = timestamp
    assert match_trace(Trace.model_validate(payload))["status"] == "unresolved"


def test_disconnected_graph_cannot_claim_a_complete_connected_path() -> None:
    from dofek_ml.matching_map import Trace, match_trace

    payload = trace_input()
    payload["nodes"].append({"id": "d", "latitude": 37.0, "longitude": -121.997})
    payload["edges"] = [["a", "b"], ["c", "d"]]
    payload["expected_edges"] = None
    payload["observations"][-1]["longitude"] = -121.9972
    assert match_trace(Trace.model_validate(payload))["status"] == "unresolved"


def test_dense_reverse_progress_is_unresolved_despite_full_observation_coverage() -> None:
    from dofek_ml.matching_map import Trace, match_trace

    trace = Trace.model_validate(
        {
            "provenance": "synthetic slow reverse travel",
            "nodes": [
                {"id": "a", "latitude": 37, "longitude": -122},
                {"id": "b", "latitude": 37, "longitude": -121.998},
            ],
            "edges": [["a", "b"]],
            "observations": [
                {"latitude": 37, "longitude": -121.9995 - index * 0.00002, "timestamp": index}
                for index in range(25)
            ],
        }
    )
    result = match_trace(trace)
    assert result["status"] == "unresolved"
    assert result["direction_conflict"] is True


def test_trace_can_start_inside_a_long_directed_edge() -> None:
    from dofek_ml.matching_map import Trace, match_trace

    trace = Trace.model_validate(
        {
            "provenance": "synthetic long edge",
            "nodes": [
                {"id": "external:a", "latitude": 37, "longitude": -122},
                {"id": "external:b", "latitude": 37, "longitude": -121.99},
            ],
            "edges": [["external:a", "external:b"]],
            "observations": [
                {"latitude": 37, "longitude": longitude, "timestamp": index}
                for index, longitude in enumerate((-121.996, -121.9958, -121.9956))
            ],
        }
    )
    result = match_trace(trace)
    assert result["status"] == "complete"
    assert result["edges"] == [["external:a", "external:b"]]
    assert result["coverage"] == 1


@pytest.mark.parametrize("failure", ["time", "coordinate", "edge"])
def test_rejects_invalid_graph_and_trace_inputs(failure: str) -> None:
    from dofek_ml.matching_map import Trace

    payload = trace_input()
    if failure == "time":
        payload["observations"][-1]["timestamp"] = 0
    elif failure == "coordinate":
        payload["nodes"][0]["latitude"] = 91
    else:
        payload["edges"].append(["missing", "a"])
    with pytest.raises(ValueError, match=".+"):
        Trace.model_validate(payload)
