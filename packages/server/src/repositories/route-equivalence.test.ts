import { describe, expect, it } from "vitest";
import type { NormalizedRoutePoint, RouteGeometry } from "./repeated-effort-types.ts";
import { evaluateRouteMatch } from "./route-equivalence.ts";

const routePoints: readonly NormalizedRoutePoint[] = [
  { lat: 37.7749, lng: -122.4194, elevation_meters: 10 },
  { lat: 37.7758, lng: -122.4182, elevation_meters: 18 },
  { lat: 37.7767, lng: -122.417, elevation_meters: 12 },
  { lat: 37.7776, lng: -122.4158, elevation_meters: 20 },
];

const shortSharedSection = Array.from({ length: 30 }, (_, index) => ({
  lat: 0.0001 * index,
  lng: 0,
}));
const leftLongRoute: readonly NormalizedRoutePoint[] = [
  ...shortSharedSection,
  { lat: 0.0029, lng: 0.005 },
  { lat: 0.009, lng: 0.005 },
  { lat: 0.009, lng: 0 },
];
const rightLongRoute: readonly NormalizedRoutePoint[] = [
  ...shortSharedSection,
  { lat: 0.0029, lng: -0.005 },
  { lat: 0.009, lng: -0.005 },
  { lat: 0.009, lng: 0 },
];

describe("route equivalence", () => {
  it("accepts a high-confidence forward geometry match", () => {
    expect(evaluateRouteMatch({ left: routePoints, right: routePoints })).toEqual({
      matched: true,
      strength: "strong_inferred",
      direction: "forward",
      overlap_percentage: 1,
      distance_difference: 0,
      start_tolerance_meters: 0,
      end_tolerance_meters: 0,
      elevation_similarity: 1,
      confidence: 1,
      rejection_reasons: [],
      left_quality: { geometry_status: null, coverage_pct: null, largest_gap_seconds: null },
      right_quality: { geometry_status: null, coverage_pct: null, largest_gap_seconds: null },
    });
  });

  it.each([true, false])("preserves both routes' quality for matched=%s", (matched) => {
    const left: RouteGeometry = {
      points: routePoints,
      geometry_status: "available",
      coverage_pct: 100,
      largest_gap_seconds: 10,
    };
    const right: RouteGeometry = {
      points: matched
        ? routePoints
        : routePoints.map((point) => ({ ...point, lat: point.lat + 1 })),
      geometry_status: "available",
      coverage_pct: 60,
      largest_gap_seconds: 120,
    };
    expect(evaluateRouteMatch({ left, right })).toMatchObject({
      matched,
      left_quality: { geometry_status: "available", coverage_pct: 100, largest_gap_seconds: 10 },
      right_quality: { geometry_status: "available", coverage_pct: 60, largest_gap_seconds: 120 },
    });
  });

  it("preserves measured zero quality separately from unavailable evidence", () => {
    expect(
      evaluateRouteMatch({
        left: { points: routePoints, coverage_pct: 0, largest_gap_seconds: 0 },
        right: { points: routePoints, coverage_pct: null, largest_gap_seconds: null },
      }),
    ).toMatchObject({
      left_quality: { geometry_status: null, coverage_pct: 0, largest_gap_seconds: 0 },
      right_quality: { geometry_status: null, coverage_pct: null, largest_gap_seconds: null },
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
      right_distance_meters: 1_111.111111,
      left_elevation_profile: [0, 10, 20, 30],
      right_elevation_profile: [0, 11.5, 18.5, 30],
    });

    expect(result).not.toBeNull();
    expect(result?.distance_difference).toBeCloseTo(0.1, 6);
    expect(result?.elevation_similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("accepts the exact elevation similarity boundary", () => {
    const result = evaluateRouteMatch({
      left: routePoints,
      right: routePoints,
      left_elevation_profile: [0, 0],
      right_elevation_profile: [0, 0.3],
    });

    expect(result?.elevation_similarity).toBeCloseTo(0.85, 10);
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

  it("does not infer a route from partial geometry", () => {
    expect(
      evaluateRouteMatch({
        left: { points: routePoints, geometry_status: "partial" },
        right: routePoints,
      }),
    ).toBeNull();
  });

  it("returns observable rejection reasons for complete but non-equivalent routes", () => {
    const unrelatedPoints: readonly NormalizedRoutePoint[] = [
      { lat: 37.8, lng: -122.4 },
      { lat: 37.801, lng: -122.399 },
      { lat: 37.802, lng: -122.398 },
      { lat: 37.803, lng: -122.397 },
    ];

    expect(evaluateRouteMatch({ left: routePoints, right: unrelatedPoints })).toEqual(
      expect.objectContaining({
        matched: false,
        rejection_reasons: expect.arrayContaining([
          "overlap_below_threshold",
          "endpoint_tolerance_above_threshold",
        ]),
      }),
    );
  });

  it("weights overlap by covered route length instead of vertex counts", () => {
    const result = evaluateRouteMatch({
      left: leftLongRoute,
      right: rightLongRoute,
      left_distance_meters: 2_200,
      right_distance_meters: 2_200,
    });

    expect(result).toEqual(
      expect.objectContaining({
        matched: false,
        rejection_reasons: expect.arrayContaining(["overlap_below_threshold"]),
      }),
    );
  });

  it("rejects a route whose elevation similarity is below the threshold", () => {
    expect(
      evaluateRouteMatch({
        left: routePoints,
        right: routePoints,
        left_elevation_profile: [0, 0, 0, 0],
        right_elevation_profile: [0, 100, 0, 100],
      }),
    ).toEqual(
      expect.objectContaining({
        matched: false,
        rejection_reasons: expect.arrayContaining(["elevation_similarity_below_threshold"]),
      }),
    );
  });

  it("returns null for incomplete geometry", () => {
    expect(evaluateRouteMatch({ left: routePoints.slice(0, 1), right: routePoints })).toBeNull();
    expect(evaluateRouteMatch({ left: routePoints, right: [] })).toBeNull();
  });
});
