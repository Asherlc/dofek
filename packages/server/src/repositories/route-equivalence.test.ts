import { describe, expect, it } from "vitest";
import type { NormalizedRoutePoint } from "./repeated-effort-types.ts";
import { evaluateRouteMatch } from "./route-equivalence.ts";

const routePoints: readonly NormalizedRoutePoint[] = [
  { lat: 37.7749, lng: -122.4194, elevation_meters: 10 },
  { lat: 37.7758, lng: -122.4182, elevation_meters: 18 },
  { lat: 37.7767, lng: -122.417, elevation_meters: 12 },
  { lat: 37.7776, lng: -122.4158, elevation_meters: 20 },
];

describe("route equivalence", () => {
  it("accepts a high-confidence forward geometry match", () => {
    expect(evaluateRouteMatch({ left: routePoints, right: routePoints })).toEqual({
      direction: "forward",
      overlap_percentage: 1,
      distance_difference: 0,
      start_tolerance_meters: 0,
      end_tolerance_meters: 0,
      elevation_similarity: 1,
      confidence: 1,
      rejection_reasons: [],
    });
  });

  it("identifies a route recorded in reverse", () => {
    const result = evaluateRouteMatch({ left: routePoints, right: [...routePoints].reverse() });

    expect(result).toEqual(
      expect.objectContaining({
        direction: "reverse",
        overlap_percentage: 1,
        elevation_similarity: 1,
      }),
    );
    expect(result?.start_tolerance_meters).toBe(0);
    expect(result?.end_tolerance_meters).toBe(0);
  });

  it("accepts the stated overlap, endpoint, distance, and elevation boundaries", () => {
    const result = evaluateRouteMatch({
      left: routePoints,
      right: routePoints,
      left_distance_meters: 1_000,
      right_distance_meters: 1_100,
      left_elevation_profile: [0, 10, 20, 30],
      right_elevation_profile: [0, 11.5, 18.5, 30],
    });

    expect(result).not.toBeNull();
    expect(result?.distance_difference).toBeCloseTo(0.0909, 3);
    expect(result?.elevation_similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("allows a match when only one elevation profile exists", () => {
    expect(
      evaluateRouteMatch({
        left: routePoints,
        right: routePoints.map(({ lat, lng }) => ({ lat, lng })),
        left_elevation_profile: [0, 10, 20, 30],
      }),
    ).toEqual(expect.objectContaining({ elevation_similarity: null }));
  });

  it("rejects routes below the overlap or endpoint thresholds", () => {
    const unrelatedPoints: readonly NormalizedRoutePoint[] = [
      { lat: 37.8, lng: -122.4 },
      { lat: 37.801, lng: -122.399 },
      { lat: 37.802, lng: -122.398 },
      { lat: 37.803, lng: -122.397 },
    ];

    expect(evaluateRouteMatch({ left: routePoints, right: unrelatedPoints })).toBeNull();
  });

  it("rejects a route whose elevation similarity is below the threshold", () => {
    expect(
      evaluateRouteMatch({
        left: routePoints,
        right: routePoints,
        left_elevation_profile: [0, 0, 0, 0],
        right_elevation_profile: [0, 100, 0, 100],
      }),
    ).toBeNull();
  });

  it("returns null for incomplete geometry", () => {
    expect(evaluateRouteMatch({ left: routePoints.slice(0, 1), right: routePoints })).toBeNull();
    expect(evaluateRouteMatch({ left: routePoints, right: [] })).toBeNull();
  });
});
