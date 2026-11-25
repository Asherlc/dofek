import { describe, expect, it } from "vitest";
import type { NormalizedRoutePoint } from "./repeated-effort-types.ts";
import { groupEquivalentRoutes, routeGeometry } from "./route-equivalence.ts";

const routePoints: readonly NormalizedRoutePoint[] = [
  { lat: 37.7749, lng: -122.4194, elevation_meters: 10 },
  { lat: 37.7758, lng: -122.4182, elevation_meters: 18 },
  { lat: 37.7767, lng: -122.417, elevation_meters: 12 },
  { lat: 37.7776, lng: -122.4158, elevation_meters: 20 },
];

function servingRoute(
  canonicalActivityId: string,
  points: readonly NormalizedRoutePoint[] = routePoints,
) {
  return {
    canonical_activity_id: canonicalActivityId,
    points: points.map(({ lat, lng }): [number, number] => [lat, lng]),
    route_distance_meters: null,
    elevation_profile: points.flatMap((point) =>
      point.elevation_meters === undefined ? [] : [point.elevation_meters],
    ),
    geometry_status: "available" as const,
    coverage_pct: 100,
    largest_gap_seconds: 0,
  };
}

function activity(activityId: string, canonicalType = "cycling", modality: string | null = "road") {
  return { activity_id: activityId, canonical_type: canonicalType, modality };
}

describe("route equivalence", () => {
  it("preserves every serving geometry field", () => {
    const route = {
      ...servingRoute("route-a"),
      route_distance_meters: 12_345,
      elevation_profile: [1, 2, 3],
      geometry_status: "partial" as const,
      coverage_pct: 82,
      largest_gap_seconds: 45,
    };

    expect(routeGeometry(route)).toEqual({
      points: route.points.map(([lat, lng]) => ({ lat, lng })),
      distance_meters: 12_345,
      elevation_profile: [1, 2, 3],
      geometry_status: "partial",
      coverage_pct: 82,
      largest_gap_seconds: 45,
    });
  });

  it("groups equivalent routes deterministically without mutating caller order", async () => {
    const routes = [servingRoute("route-b"), servingRoute("route-a")];

    const groups = await groupEquivalentRoutes(routes, [activity("route-a"), activity("route-b")]);

    expect(groups.map((group) => group.map((route) => route.canonical_activity_id))).toEqual([
      ["route-a", "route-b"],
    ]);
    expect(routes.map((route) => route.canonical_activity_id)).toEqual(["route-b", "route-a"]);
  });

  it("stops before aggregate sampled-segment work exceeds the request budget", async () => {
    const denseRoute = Array.from({ length: 64 }, (_, index) => ({
      lat: 37 + index * 0.000_001,
      lng: -122,
    }));
    const routes = Array.from({ length: 33 }, (_, index) =>
      servingRoute(`route-${String(index).padStart(3, "0")}`, denseRoute),
    );
    const activities = routes.map((route) => activity(route.canonical_activity_id));

    await expect(groupEquivalentRoutes(routes, activities)).rejects.toThrow(
      "Route grouping sampled-segment work limit exceeded: narrow the date range or filters.",
    );
  });

  it("keeps activity types and modalities in separate equivalence groups", async () => {
    const routes = [servingRoute("road"), servingRoute("indoor"), servingRoute("run")];
    const groups = await groupEquivalentRoutes(routes, [
      activity("road", "cycling", "road"),
      activity("indoor", "cycling", "indoor"),
      activity("run", "running", "road"),
    ]);

    expect(groups.map((group) => group.map((route) => route.canonical_activity_id))).toEqual([
      ["indoor"],
      ["road"],
      ["run"],
    ]);
  });

  it("skips missing activity metadata and routes that fail their own quality check", async () => {
    const partial = { ...servingRoute("partial"), geometry_status: "partial" as const };
    const groups = await groupEquivalentRoutes(
      [servingRoute("missing"), partial, servingRoute("valid")],
      [activity("partial"), activity("valid")],
    );

    expect(groups.map((group) => group.map((route) => route.canonical_activity_id))).toEqual([
      ["valid"],
    ]);
  });

  it("uses complete-link matching instead of transitively merging similar routes", async () => {
    const shiftedLine = (start: number) => [
      { lat: start, lng: 0 },
      { lat: start + 0.02, lng: 0 },
    ];
    const routes = [
      servingRoute("a", shiftedLine(0)),
      servingRoute("b", shiftedLine(0.0012)),
      servingRoute("c", shiftedLine(0.0024)),
    ];

    const groups = await groupEquivalentRoutes(routes, [
      activity("a"),
      activity("b"),
      activity("c"),
    ]);

    expect(groups.map((group) => group.map((route) => route.canonical_activity_id))).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });

  it("allows exactly 250 candidates and rejects 251", async () => {
    const routesAtLimit = Array.from({ length: 250 }, (_, index) =>
      servingRoute(`missing-${String(index).padStart(3, "0")}`),
    );

    await expect(groupEquivalentRoutes(routesAtLimit, [])).resolves.toEqual([]);
    await expect(
      groupEquivalentRoutes([...routesAtLimit, servingRoute("missing-250")], []),
    ).rejects.toThrow("Too many route candidates");
  });
});
