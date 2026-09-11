import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type {
  NormalizedRoutePoint,
  RouteGeometry,
  RouteMatchEvidence,
  RouteMatchInput,
  RouteQualityEvidence,
} from "./repeated-effort-types.ts";

export const ROUTE_MATCH_THRESHOLDS = {
  overlap_percentage: 0.9,
  endpoint_tolerance_meters: 250,
  distance_difference: 0.1,
  elevation_similarity: 0.85,
  coverage_pct: 90,
  largest_gap_seconds: 30,
} as const;

const routePointMatchToleranceMeters = 100;
const earthRadiusMeters = 6_371_000;

interface PreparedRoute {
  points: readonly NormalizedRoutePoint[];
  distanceMeters: number;
  elevationProfile: readonly number[] | null;
  quality: RouteQualityEvidence;
}

interface OrientationMetrics {
  direction: "forward" | "reverse" | "unknown";
  startToleranceMeters: number;
  endToleranceMeters: number;
}

function isFiniteCoordinate(point: NormalizedRoutePoint): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lng >= -180 &&
    point.lng <= 180
  );
}

function haversineMeters(left: NormalizedRoutePoint, right: NormalizedRoutePoint): number {
  const lat1 = (left.lat * Math.PI) / 180;
  const lat2 = (right.lat * Math.PI) / 180;
  const deltaLat = lat2 - lat1;
  const deltaLng = ((right.lng - left.lng) * Math.PI) / 180;
  const haversineTerm =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(Math.min(1, haversineTerm)));
}

function routeDistanceMeters(points: readonly NormalizedRoutePoint[]): number {
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previousPoint = points[index - 1];
    const currentPoint = points[index];
    if (previousPoint === undefined || currentPoint === undefined) {
      throw new Error("Route geometry endpoint is missing");
    }
    distance += haversineMeters(previousPoint, currentPoint);
  }
  return distance;
}

function pointToSegmentDistanceMeters(
  point: NormalizedRoutePoint,
  start: NormalizedRoutePoint,
  end: NormalizedRoutePoint,
): number {
  const latitudeRadians = (point.lat * Math.PI) / 180;
  const toLocal = (candidate: NormalizedRoutePoint) => ({
    x:
      ((candidate.lng - point.lng) * Math.PI * earthRadiusMeters * Math.cos(latitudeRadians)) / 180,
    y: ((candidate.lat - point.lat) * Math.PI * earthRadiusMeters) / 180,
  });
  const localPoint = { x: 0, y: 0 };
  const localStart = toLocal(start);
  const localEnd = toLocal(end);
  const segmentX = localEnd.x - localStart.x;
  const segmentY = localEnd.y - localStart.y;
  const segmentLengthSquared = segmentX ** 2 + segmentY ** 2;
  if (segmentLengthSquared === 0) {
    return Math.hypot(localStart.x, localStart.y);
  }
  const projection =
    ((localPoint.x - localStart.x) * segmentX + (localPoint.y - localStart.y) * segmentY) /
    segmentLengthSquared;
  const clampedProjection = Math.max(0, Math.min(1, projection));
  return Math.hypot(
    localPoint.x - (localStart.x + clampedProjection * segmentX),
    localPoint.y - (localStart.y + clampedProjection * segmentY),
  );
}

function nearestRouteDistanceMeters(
  point: NormalizedRoutePoint,
  route: readonly NormalizedRoutePoint[],
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < route.length; index += 1) {
    const previousPoint = route[index - 1];
    const currentPoint = route[index];
    if (previousPoint === undefined || currentPoint === undefined) {
      throw new Error("Route geometry endpoint is missing");
    }
    nearest = Math.min(nearest, pointToSegmentDistanceMeters(point, previousPoint, currentPoint));
  }
  return nearest;
}

function interpolateRoutePoint(
  start: NormalizedRoutePoint,
  end: NormalizedRoutePoint,
  fraction: number,
): NormalizedRoutePoint {
  return {
    lat: start.lat + (end.lat - start.lat) * fraction,
    lng: start.lng + (end.lng - start.lng) * fraction,
  };
}

function coveredRouteLengthMeters(
  source: readonly NormalizedRoutePoint[],
  target: readonly NormalizedRoutePoint[],
): number {
  let coveredLength = 0;
  for (let index = 1; index < source.length; index += 1) {
    const start = source[index - 1];
    const end = source[index];
    if (start === undefined || end === undefined) {
      throw new Error("Route geometry endpoint is missing");
    }
    const segmentLength = haversineMeters(start, end);
    const sampleCount = Math.max(1, Math.ceil(segmentLength / routePointMatchToleranceMeters));
    let coveredSamples = 0;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const fraction = (sampleIndex + 0.5) / sampleCount;
      const samplePoint = interpolateRoutePoint(start, end, fraction);
      if (nearestRouteDistanceMeters(samplePoint, target) <= routePointMatchToleranceMeters) {
        coveredSamples += 1;
      }
    }
    coveredLength += segmentLength * (coveredSamples / sampleCount);
  }
  return coveredLength;
}

function routeOverlapPercentage(
  left: readonly NormalizedRoutePoint[],
  right: readonly NormalizedRoutePoint[],
): number {
  const leftLength = routeDistanceMeters(left);
  const rightLength = routeDistanceMeters(right);
  const coveredLength =
    coveredRouteLengthMeters(left, right) + coveredRouteLengthMeters(right, left);
  return coveredLength / (leftLength + rightLength);
}

function profileFromGeometry(
  geometry: RouteGeometry,
  elevationProfileOverride: readonly number[] | null | undefined,
): readonly number[] | null {
  const explicitProfile = geometry.elevation_profile ?? elevationProfileOverride;
  if (explicitProfile && explicitProfile.length > 0) {
    return explicitProfile.every(Number.isFinite) ? explicitProfile : null;
  }
  const pointElevations = geometry.points.map((point) => point.elevation_meters);
  return pointElevations.every(
    (elevation): elevation is number => elevation != null && Number.isFinite(elevation),
  )
    ? pointElevations
    : null;
}

function prepareRoute(
  input: RouteMatchInput["left"],
  distanceOverride: number | null | undefined,
  elevationProfileOverride: readonly number[] | null | undefined,
): PreparedRoute | null {
  const geometry: RouteGeometry = "points" in input ? input : { points: input };
  if (geometry.geometry_status !== undefined && geometry.geometry_status !== "available")
    return null;
  if (
    geometry.geometry_status === "available" &&
    (geometry.coverage_pct == null || geometry.largest_gap_seconds == null)
  )
    return null;
  if (
    (geometry.coverage_pct != null &&
      geometry.coverage_pct < ROUTE_MATCH_THRESHOLDS.coverage_pct) ||
    (geometry.largest_gap_seconds != null &&
      geometry.largest_gap_seconds > ROUTE_MATCH_THRESHOLDS.largest_gap_seconds)
  )
    return null;
  if (geometry.points.length > 64 || (geometry.elevation_profile?.length ?? 0) > 64)
    throw new Error(
      "Route matching work limit exceeded: normalized geometry must contain at most 64 points.",
    );
  if (geometry.points.length < 2 || geometry.points.some((point) => !isFiniteCoordinate(point)))
    return null;
  const distanceMeters =
    geometry.distance_meters ?? distanceOverride ?? routeDistanceMeters(geometry.points);
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return null;
  return {
    points: geometry.points,
    distanceMeters,
    elevationProfile: profileFromGeometry(geometry, elevationProfileOverride),
    quality: {
      geometry_status: geometry.geometry_status ?? null,
      coverage_pct: geometry.coverage_pct ?? null,
      largest_gap_seconds: geometry.largest_gap_seconds ?? null,
    },
  };
}

function orientationMetrics(
  left: readonly NormalizedRoutePoint[],
  right: readonly NormalizedRoutePoint[],
): OrientationMetrics {
  const leftStart = left[0];
  const leftEnd = left.at(-1);
  const rightStart = right[0];
  const rightEnd = right.at(-1);
  if (
    leftStart === undefined ||
    leftEnd === undefined ||
    rightStart === undefined ||
    rightEnd === undefined
  ) {
    throw new Error("Route geometry endpoint is missing");
  }
  const forwardStart = haversineMeters(leftStart, rightStart);
  const forwardEnd = haversineMeters(leftEnd, rightEnd);
  const reverseStart = haversineMeters(leftStart, rightEnd);
  const reverseEnd = haversineMeters(leftEnd, rightStart);
  const forwardTotal = forwardStart + forwardEnd;
  const reverseTotal = reverseStart + reverseEnd;
  if (forwardTotal < reverseTotal) {
    return {
      direction: "forward",
      startToleranceMeters: forwardStart,
      endToleranceMeters: forwardEnd,
    };
  }
  if (reverseTotal < forwardTotal) {
    return {
      direction: "reverse",
      startToleranceMeters: reverseStart,
      endToleranceMeters: reverseEnd,
    };
  }
  return {
    direction: "unknown",
    startToleranceMeters: Math.min(forwardStart, reverseStart),
    endToleranceMeters: Math.min(forwardEnd, reverseEnd),
  };
}

function resampleProfile(profile: readonly number[], length: number): number[] {
  if (profile.length === length) return [...profile];
  return Array.from({ length }, (_, index) => {
    const position = (index * (profile.length - 1)) / (length - 1);
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    const fraction = position - lowerIndex;
    const lowerValue = profile[lowerIndex];
    const upperValue = profile[upperIndex];
    if (lowerValue === undefined || upperValue === undefined) {
      throw new Error("Elevation profile sample is missing");
    }
    return lowerValue + (upperValue - lowerValue) * fraction;
  });
}

function elevationSimilarity(
  left: readonly number[] | null,
  right: readonly number[] | null,
): number | null {
  if (left === null || right === null || left.length === 0 || right.length === 0) return null;
  const length = Math.max(left.length, right.length);
  const leftSample = resampleProfile(left, length);
  const rightSample = resampleProfile(right, length);
  const meanAbsoluteDifference =
    leftSample.reduce((sum, value, index) => {
      const rightValue = rightSample[index];
      if (rightValue === undefined) throw new Error("Elevation profile sample is missing");
      return sum + Math.abs(value - rightValue);
    }, 0) / length;
  const allValues = [...leftSample, ...rightSample];
  const profileRange = Math.max(...allValues) - Math.min(...allValues);
  return Math.max(0, Math.min(1, 1 - meanAbsoluteDifference / Math.max(profileRange, 1)));
}

function confidence(
  overlapPercentage: number,
  startToleranceMeters: number,
  endToleranceMeters: number,
  distanceDifference: number,
  elevation: number | null,
): number {
  const endpointScore =
    1 -
    Math.min(
      1,
      (startToleranceMeters + endToleranceMeters) /
        (2 * ROUTE_MATCH_THRESHOLDS.endpoint_tolerance_meters),
    );
  const distanceScore =
    1 - Math.min(1, distanceDifference / ROUTE_MATCH_THRESHOLDS.distance_difference);
  const scores = [
    { value: overlapPercentage, weight: 0.4 },
    { value: endpointScore, weight: 0.2 },
    { value: distanceScore, weight: 0.2 },
    ...(elevation === null ? [] : [{ value: elevation, weight: 0.2 }]),
  ];
  const totalWeight = scores.reduce((sum, score) => sum + score.weight, 0);
  return scores.reduce((sum, score) => sum + score.value * score.weight, 0) / totalWeight;
}

/**
 * Evaluate complete normalized route geometry against fixed repeated-effort thresholds.
 * A null result means the geometry is incomplete. Complete mismatches return
 * rejection evidence so callers can explain why no inferred identity was made.
 */
export function evaluateRouteMatch(input: RouteMatchInput): RouteMatchEvidence | null {
  const left = prepareRoute(input.left, input.left_distance_meters, input.left_elevation_profile);
  const right = prepareRoute(
    input.right,
    input.right_distance_meters,
    input.right_elevation_profile,
  );
  if (left === null || right === null) return null;

  const sampleCount = (points: readonly NormalizedRoutePoint[]) =>
    points
      .slice(1)
      .reduce(
        (count, point, index) =>
          count +
          Math.max(
            1,
            Math.ceil(
              haversineMeters(points[index] ?? point, point) / routePointMatchToleranceMeters,
            ),
          ),
        0,
      );
  const work =
    sampleCount(left.points) * (right.points.length - 1) +
    sampleCount(right.points) * (left.points.length - 1);
  if (work > 262_144)
    throw new Error(
      "Route matching work limit exceeded: route geometry is too large for a complete serving comparison.",
    );

  const orientation = orientationMetrics(left.points, right.points);
  const overlapPercentage = routeOverlapPercentage(left.points, right.points);
  const distanceDifference =
    Math.abs(left.distanceMeters - right.distanceMeters) /
    Math.max(left.distanceMeters, right.distanceMeters);
  const orientedRightElevation =
    orientation.direction === "reverse"
      ? right.elevationProfile === null
        ? null
        : [...right.elevationProfile].reverse()
      : right.elevationProfile;
  const elevation = elevationSimilarity(left.elevationProfile, orientedRightElevation);
  const rejectionReasons: string[] = [];
  if (overlapPercentage < ROUTE_MATCH_THRESHOLDS.overlap_percentage) {
    rejectionReasons.push("overlap_below_threshold");
  }
  if (
    orientation.startToleranceMeters > ROUTE_MATCH_THRESHOLDS.endpoint_tolerance_meters ||
    orientation.endToleranceMeters > ROUTE_MATCH_THRESHOLDS.endpoint_tolerance_meters
  ) {
    rejectionReasons.push("endpoint_tolerance_above_threshold");
  }
  if (distanceDifference > ROUTE_MATCH_THRESHOLDS.distance_difference) {
    rejectionReasons.push("distance_difference_above_threshold");
  }
  if (elevation !== null && elevation < ROUTE_MATCH_THRESHOLDS.elevation_similarity) {
    rejectionReasons.push("elevation_similarity_below_threshold");
  }
  const evidence = {
    left_quality: left.quality,
    right_quality: right.quality,
    direction: orientation.direction,
    overlap_percentage: overlapPercentage,
    distance_difference: distanceDifference,
    start_tolerance_meters: orientation.startToleranceMeters,
    end_tolerance_meters: orientation.endToleranceMeters,
    elevation_similarity: elevation,
    confidence: confidence(
      overlapPercentage,
      orientation.startToleranceMeters,
      orientation.endToleranceMeters,
      distanceDifference,
      elevation,
    ),
  };
  return rejectionReasons.length > 0
    ? { ...evidence, matched: false, rejection_reasons: rejectionReasons }
    : { ...evidence, matched: true, strength: "strong_inferred", rejection_reasons: [] };
}

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
  for (const route of [...routes].sort((a, b) =>
    a.canonical_activity_id.localeCompare(b.canonical_activity_id),
  )) {
    const activity = byId.get(route.canonical_activity_id);
    if (!activity) continue;
    await yieldToEventLoop();
    if (!evaluateRouteMatch({ left: routeGeometry(route), right: routeGeometry(route) })?.matched)
      continue;
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
        if (
          !evaluateRouteMatch({ left: routeGeometry(other), right: routeGeometry(route) })?.matched
        ) {
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
