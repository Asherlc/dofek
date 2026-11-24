import { describe, expect, it } from "vitest";
import {
  evaluateRouteMatch,
  type NormalizedRoutePoint,
  ROUTE_MATCH_THRESHOLDS,
  type RouteGeometry,
} from "./route-equivalence.ts";

const routePoints: readonly NormalizedRoutePoint[] = [
  { lat: 37.7749, lng: -122.4194, elevation_meters: 10 },
  { lat: 37.7758, lng: -122.4182, elevation_meters: 18 },
  { lat: 37.7767, lng: -122.417, elevation_meters: 12 },
  { lat: 37.7776, lng: -122.4158, elevation_meters: 20 },
];
const validRoutePoint: NormalizedRoutePoint = {
  lat: 37.7758,
  lng: -122.4182,
  elevation_meters: 18,
};

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
  it("does not infer equivalence when a serving row lacks recording quality", () => {
    expect(
      evaluateRouteMatch({
        left: {
          points: routePoints,
          geometry_status: "available",
          coverage_pct: null,
          largest_gap_seconds: null,
        },
        right: routePoints,
      }),
    ).toBeNull();
  });
  it.each([
    { coverage_pct: 1, largest_gap_seconds: 3600 },
    { coverage_pct: 100, largest_gap_seconds: 3600 },
  ])("rejects incomplete recording quality %o", (quality) => {
    expect(
      evaluateRouteMatch({
        left: { points: routePoints, geometry_status: "available", ...quality },
        right: routePoints,
      })?.matched,
    ).not.toBe(true);
  });
  it("bounds work for geographically unbounded polylines", () => {
    const points = Array.from({ length: 65 }, (_, index) => ({ lat: index * 0.0001, lng: 0 }));
    expect(() => evaluateRouteMatch({ left: points, right: points })).toThrow(
      "Route matching work limit",
    );
  });
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
      coverage_pct: 95,
      largest_gap_seconds: 15,
    };
    expect(evaluateRouteMatch({ left, right })).toMatchObject({
      matched,
      left_quality: { geometry_status: "available", coverage_pct: 100, largest_gap_seconds: 10 },
      right_quality: { geometry_status: "available", coverage_pct: 95, largest_gap_seconds: 15 },
    });
  });

  it("rejects measured zero coverage", () => {
    expect(
      evaluateRouteMatch({
        left: { points: routePoints, coverage_pct: 0, largest_gap_seconds: 0 },
        right: { points: routePoints, coverage_pct: null, largest_gap_seconds: null },
      }),
    ).toBeNull();
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

  it.each([
    { label: "non-finite latitude", point: { lat: Number.NaN, lng: 0 } },
    { label: "non-finite longitude", point: { lat: 0, lng: Number.POSITIVE_INFINITY } },
    { label: "latitude below range", point: { lat: -90.000_001, lng: 0 } },
    { label: "latitude above range", point: { lat: 90.000_001, lng: 0 } },
    { label: "longitude below range", point: { lat: 0, lng: -180.000_001 } },
    { label: "longitude above range", point: { lat: 0, lng: 180.000_001 } },
  ])("rejects $label", ({ point }) => {
    expect(evaluateRouteMatch({ left: [point, validRoutePoint], right: routePoints })).toBeNull();
  });

  it.each([
    { lat: -90, lng: -180 },
    { lat: 90, lng: 180 },
  ])("accepts inclusive coordinate limits %o", (boundary) => {
    const points = [boundary, { lat: boundary.lat * 0.999, lng: boundary.lng * 0.999 }];
    expect(
      evaluateRouteMatch({
        left: points,
        right: points,
        left_distance_meters: 1_000,
        right_distance_meters: 1_000,
      })?.matched,
    ).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
    "rejects an unusable distance override %s",
    (distance) => {
      expect(
        evaluateRouteMatch({
          left: routePoints,
          right: routePoints,
          left_distance_meters: distance,
        }),
      ).toBeNull();
    },
  );

  it("accepts exact recording-quality and geometry-size limits", () => {
    const points = Array.from({ length: 64 }, (_, index) => ({
      lat: 37 + index * 0.000_01,
      lng: -122,
    }));
    const geometry: RouteGeometry = {
      points,
      elevation_profile: Array.from({ length: 64 }, (_, index) => index),
      geometry_status: "available",
      coverage_pct: ROUTE_MATCH_THRESHOLDS.coverage_pct,
      largest_gap_seconds: ROUTE_MATCH_THRESHOLDS.largest_gap_seconds,
    };

    expect(evaluateRouteMatch({ left: geometry, right: geometry })?.matched).toBe(true);
  });

  it.each([
    {
      coverage_pct: ROUTE_MATCH_THRESHOLDS.coverage_pct - 0.001,
      largest_gap_seconds: ROUTE_MATCH_THRESHOLDS.largest_gap_seconds,
    },
    {
      coverage_pct: ROUTE_MATCH_THRESHOLDS.coverage_pct,
      largest_gap_seconds: ROUTE_MATCH_THRESHOLDS.largest_gap_seconds + 0.001,
    },
  ])("rejects recording quality just outside its limit %o", (quality) => {
    expect(
      evaluateRouteMatch({
        left: { points: routePoints, geometry_status: "available", ...quality },
        right: routePoints,
      }),
    ).toBeNull();
  });

  it("rejects a 65-sample elevation profile even with bounded geometry", () => {
    expect(() =>
      evaluateRouteMatch({
        left: { points: routePoints, elevation_profile: Array.from({ length: 65 }, () => 1) },
        right: routePoints,
      }),
    ).toThrow("Route matching work limit");
  });

  it("treats non-finite elevation samples as unavailable rather than comparable", () => {
    const result = evaluateRouteMatch({
      left: { points: routePoints, elevation_profile: [0, Number.NaN, 20, 30] },
      right: routePoints,
    });

    expect(result).toMatchObject({ matched: true, elevation_similarity: null });
  });

  it("uses point elevations when no explicit profile exists", () => {
    const result = evaluateRouteMatch({
      left: routePoints,
      right: routePoints.map((point) => ({ ...point, elevation_meters: 100 })),
    });

    expect(result).toMatchObject({
      matched: false,
      elevation_similarity: expect.any(Number),
      rejection_reasons: expect.arrayContaining(["elevation_similarity_below_threshold"]),
    });
  });

  it("prefers geometry elevation data over an input override", () => {
    const result = evaluateRouteMatch({
      left: { points: routePoints, elevation_profile: [0, 10] },
      right: { points: routePoints, elevation_profile: [0, 10] },
      left_elevation_profile: [0, 100],
      right_elevation_profile: [100, 0],
    });

    expect(result).toMatchObject({ matched: true, elevation_similarity: 1 });
  });

  it("resamples unequal elevation profiles and reports the calculated similarity", () => {
    const result = evaluateRouteMatch({
      left: routePoints.map(({ lat, lng }) => ({ lat, lng })),
      right: routePoints.map(({ lat, lng }) => ({ lat, lng })),
      left_elevation_profile: [0, 20],
      right_elevation_profile: [0, 5, 15, 20],
    });

    expect(result?.elevation_similarity).toBeCloseTo(23 / 24, 10);
    expect(result?.matched).toBe(true);
  });

  it("marks a closed course orientation as unknown", () => {
    const closedCourse = [
      { lat: 37, lng: -122, elevation_meters: 0 },
      { lat: 37.001, lng: -122, elevation_meters: 10 },
      { lat: 37, lng: -122, elevation_meters: 0 },
    ];

    expect(evaluateRouteMatch({ left: closedCourse, right: closedCourse })).toMatchObject({
      matched: true,
      direction: "unknown",
      start_tolerance_meters: 0,
      end_tolerance_meters: 0,
    });
  });

  it("reverses elevation evidence together with route direction", () => {
    const withoutElevation = routePoints.map(({ lat, lng }) => ({ lat, lng }));
    const result = evaluateRouteMatch({
      left: withoutElevation,
      right: [...withoutElevation].reverse(),
      left_elevation_profile: [0, 10, 20, 30],
      right_elevation_profile: [30, 20, 10, 0],
    });

    expect(result).toMatchObject({
      matched: true,
      direction: "reverse",
      elevation_similarity: 1,
    });
  });

  it("reports distance rejection and a confidence reflecting every evidence component", () => {
    const result = evaluateRouteMatch({
      left: routePoints,
      right: routePoints,
      left_distance_meters: 1_000,
      right_distance_meters: 1_250,
      left_elevation_profile: [0, 10],
      right_elevation_profile: [0, 10],
    });

    expect(result).toMatchObject({
      matched: false,
      overlap_percentage: 1,
      distance_difference: 0.2,
      elevation_similarity: 1,
      confidence: 0.8,
      rejection_reasons: ["distance_difference_above_threshold"],
    });
  });

  it("normalizes confidence weights when elevation evidence is unavailable", () => {
    const points = routePoints.map(({ lat, lng }) => ({ lat, lng }));
    const result = evaluateRouteMatch({
      left: points,
      right: points,
      left_distance_meters: 1_000,
      right_distance_meters: 1_250,
    });

    expect(result?.confidence).toBeCloseTo(0.75, 10);
  });
});
