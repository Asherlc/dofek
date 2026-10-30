"""Sequence-aware offline HMM matching to a caller-owned directed network."""

from importlib.metadata import version
from typing import Self, TypedDict

from leuvenmapmatching.map.inmem import InMemMap
from leuvenmapmatching.matcher.distance import DistanceMatcher
from pydantic import Field, model_validator

from dofek_ml.matching_data import InputModel


class Point(InputModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class Node(Point):
    id: str = Field(min_length=1)


class Observation(Point):
    timestamp: float


class Trace(InputModel):
    provenance: str = Field(min_length=1)
    nodes: list[Node] = Field(min_length=2)
    edges: list[tuple[str, str]] = Field(min_length=1)
    observations: list[Observation] = Field(min_length=2)
    expected_edges: list[tuple[str, str]] | None = None

    @model_validator(mode="after")
    def validate_graph(self) -> Self:
        ids = {node.id for node in self.nodes}
        if len(ids) != len(self.nodes):
            raise ValueError("Graph node IDs must be unique")
        if len(set(self.edges)) != len(self.edges):
            raise ValueError("Graph edges must be unique")
        for left, right in [*self.edges, *(self.expected_edges or [])]:
            if left not in ids or right not in ids or left == right:
                raise ValueError("Edges must reference distinct known graph nodes")
        if self.expected_edges and not set(self.expected_edges) <= set(self.edges):
            raise ValueError("Expected edges must exist in the directed graph")
        if any(
            left.timestamp >= right.timestamp
            for left, right in zip(self.observations, self.observations[1:], strict=False)
        ):
            raise ValueError("Observation timestamps must increase strictly")
        return self


class TraceResult(TypedDict):
    engine: str
    engine_version: str
    provenance: str
    status: str
    edges: list[list[str]]
    path: list[str]
    matched_observations: int
    total_observations: int
    coverage: float
    direction_conflict: bool
    expected_edge_recall: float | None
    settings: dict[str, int]


def match_trace(trace: Trace) -> TraceResult:
    labels = [node.id for node in trace.nodes]
    node_ids = {label: index for index, label in enumerate(labels)}
    graph = {
        node_ids[node.id]: (
            (node.latitude, node.longitude),
            [node_ids[right] for left, right in trace.edges if left == node.id],
        )
        for node in trace.nodes
    }
    network = InMemMap("offline", graph=graph, use_latlon=True, use_rtree=True, index_edges=True)
    matcher = DistanceMatcher(
        network,
        max_dist=100,
        obs_noise=20,
        dist_noise=20,
        max_lattice_width=10,
        non_emitting_states=True,
    )
    states, _ = matcher.match([(point.latitude, point.longitude) for point in trace.observations])
    edges: list[list[str]] = []
    for edge in states:
        external_edge = [labels[int(node)] for node in edge]
        if not edges or edges[-1] != external_edge:
            edges.append(external_edge)
    direction_conflict = False
    previous_edge: tuple[int, int] | None = None
    furthest = 0.0
    for state in matcher.lattice_best:
        if state.obs_ne != 0:
            continue
        segment = state.edge_m
        key = (int(segment.l1), int(segment.l2))
        progress = float(segment.ti)
        if key != previous_edge:
            furthest = progress
            previous_edge = key
        furthest = max(furthest, progress)
        # Directed-edge progress may jitter within the configured observation noise.
        if (furthest - progress) * network.distance(segment.p1, segment.p2) > 20:
            direction_conflict = True
    observed = {state.obs for state in matcher.lattice_best if state.obs_ne == 0}
    matched = len(observed)
    complete = matched == len(trace.observations) and bool(edges) and not direction_conflict
    expected = set(trace.expected_edges or [])
    actual = {tuple(edge) for edge in edges}
    return {
        "engine": "leuvenmapmatching",
        "engine_version": version("leuvenmapmatching"),
        "provenance": trace.provenance,
        "status": "complete" if complete else "unresolved",
        "edges": edges,
        "path": [labels[int(node)] for node in matcher.path_pred_onlynodes] if edges else [],
        "matched_observations": matched,
        "total_observations": len(trace.observations),
        "coverage": matched / len(trace.observations),
        "direction_conflict": direction_conflict,
        "expected_edge_recall": len(expected & actual) / len(expected) if expected else None,
        "settings": {
            "max_distance_metres": 100,
            "observation_noise_metres": 20,
            "distance_noise_metres": 20,
            "max_lattice_width": 10,
        },
    }
