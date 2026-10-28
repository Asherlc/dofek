import { describe, expect, it } from "vitest";
import { type RouteComparison, resolveRouteComparisonSelection } from "./route-comparison.ts";

const firstAnchor = "00000000-0000-4000-8000-000000000001";
const newAnchor = "00000000-0000-4000-8000-000000000010";
const previousAnchor = "00000000-0000-4000-8000-000000000020";

function route(routeId: string, activityIds: string[]): RouteComparison {
  return {
    routeId,
    activityName: "Hiking",
    activityType: "hiking",
    attemptCount: activityIds.length,
    instances: activityIds.map((activityId) => ({
      activityId,
      activityName: "Morning hike",
      startedAt: "2026-10-20T08:00:00Z",
      date: "2026-10-20",
      distanceKm: 5,
      durationMinutes: 60,
      averagePaceMinPerKm: 12,
      avgHeartRate: null,
      elevationGainMeters: 100,
    })),
  };
}

const unrelated = route(firstAnchor, [firstAnchor, "00000000-0000-4000-8000-000000000002"]);
const selected = route(newAnchor, [newAnchor, previousAnchor]);

describe("resolveRouteComparisonSelection", () => {
  it("keeps a current anchor selected even when it is not the first route", () => {
    expect(resolveRouteComparisonSelection([unrelated, selected], newAnchor)).toBe(selected);
  });

  it("follows the prior anchor's activity membership when an imported attempt changes the anchor", () => {
    expect(resolveRouteComparisonSelection([unrelated, selected], previousAnchor)).toBe(selected);
  });

  it("prefers a current anchor over membership in another returned group", () => {
    const current = route(previousAnchor, [previousAnchor, "00000000-0000-4000-8000-000000000030"]);
    expect(resolveRouteComparisonSelection([selected, current], previousAnchor)).toBe(current);
  });

  it.each([undefined, "00000000-0000-4000-8000-000000000099"])(
    "uses the first route when the stored selection is %s",
    (routeId) => {
      expect(resolveRouteComparisonSelection([unrelated, selected], routeId)).toBe(unrelated);
    },
  );

  it("has no selection when no routes remain", () => {
    expect(resolveRouteComparisonSelection([], previousAnchor)).toBeUndefined();
  });
});
