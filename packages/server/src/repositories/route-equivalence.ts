import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  evaluateRouteMatch,
  ROUTE_MATCH_THRESHOLDS,
  type RouteGeometry,
  routeComparisonWork,
} from "@dofek/training/route-equivalence";

export { evaluateRouteMatch, ROUTE_MATCH_THRESHOLDS };

const maximumRouteGroupingWork = 4_194_304;

interface ServingRoute {
  canonical_activity_id: string;
  points: [number, number][];
  route_distance_meters: number | null;
  elevation_profile: number[];
  geometry_status: "available" | "partial" | "unavailable";
  coverage_pct: number | null;
  largest_gap_seconds: number | null;
}

export function routeGeometry(route: ServingRoute): RouteGeometry {
  return {
    points: route.points.map(([lat, lng]) => ({ lat, lng })),
    distance_meters: route.route_distance_meters,
    elevation_profile: route.elevation_profile,
    geometry_status: route.geometry_status,
    coverage_pct: route.coverage_pct,
    largest_gap_seconds: route.largest_gap_seconds,
  };
}

/** Deterministic complete-link groups; each bounded comparison yields to serving I/O. */
export async function groupEquivalentRoutes<T extends ServingRoute>(
  routes: T[],
  activities: readonly { activity_id: string; canonical_type: string; modality: string | null }[],
): Promise<T[][]> {
  if (routes.length > 250)
    throw new Error("Too many route candidates; narrow the date range or filters.");
  const byId = new Map(activities.map((activity) => [activity.activity_id, activity]));
  const groups: T[][] = [];
  let sampledSegmentWork = 0;
  const routesMatch = (left: T, right: T): boolean => {
    const leftGeometry = routeGeometry(left);
    const rightGeometry = routeGeometry(right);
    sampledSegmentWork += routeComparisonWork(leftGeometry.points, rightGeometry.points);
    if (sampledSegmentWork > maximumRouteGroupingWork) {
      throw new Error(
        "Route grouping sampled-segment work limit exceeded: narrow the date range or filters.",
      );
    }
    return Boolean(evaluateRouteMatch({ left: leftGeometry, right: rightGeometry })?.matched);
  };
  for (const route of [...routes].sort((a, b) =>
    a.canonical_activity_id.localeCompare(b.canonical_activity_id),
  )) {
    const activity = byId.get(route.canonical_activity_id);
    if (!activity) continue;
    await yieldToEventLoop();
    if (!routesMatch(route, route)) continue;
    let matching: T[] | undefined;
    for (const group of groups) {
      let matches = true;
      for (const other of group) {
        const otherActivity = byId.get(other.canonical_activity_id);
        if (
          activity.canonical_type !== otherActivity?.canonical_type ||
          activity.modality !== otherActivity?.modality
        ) {
          matches = false;
          break;
        }
        await yieldToEventLoop();
        if (!routesMatch(other, route)) {
          matches = false;
          break;
        }
      }
      if (matches) {
        matching = group;
        break;
      }
    }
    if (matching) matching.push(route);
    else groups.push([route]);
  }
  return groups;
}
