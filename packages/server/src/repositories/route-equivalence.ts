import type {
  NormalizedRoutePoint,
  RouteGeometry,
  RouteMatchEvidence,
  RouteMatchInput,
} from "./repeated-effort-types.ts";

export const ROUTE_MATCH_THRESHOLDS = {
  overlap_percentage: 0.9,
  endpoint_tolerance_meters: 250,
  distance_difference: 0.1,
  elevation_similarity: 0.85,
} as const;

const routePointMatchToleranceMeters = 100;
const earthRadiusMeters = 6_371_000;

interface PreparedRoute {
  points: readonly NormalizedRoutePoint[];
  distanceMeters: number;
  elevationProfile: readonly number[] | null;
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

function routeOverlapPercentage(
  left: readonly NormalizedRoutePoint[],
  right: readonly NormalizedRoutePoint[],
): number {
  const leftCovered = left.filter(
    (point) => nearestRouteDistanceMeters(point, right) <= routePointMatchToleranceMeters,
  ).length;
  const rightCovered = right.filter(
    (point) => nearestRouteDistanceMeters(point, left) <= routePointMatchToleranceMeters,
  ).length;
  return (leftCovered + rightCovered) / (left.length + right.length);
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
  const geometry: RouteGeometry = Array.isArray(input) ? { points: input } : input;
  if (geometry.geometry_status !== undefined && geometry.geometry_status !== "available")
    return null;
  if (geometry.points.length < 2 || geometry.points.some((point) => !isFiniteCoordinate(point)))
    return null;
  const distanceMeters =
    geometry.distance_meters ?? distanceOverride ?? routeDistanceMeters(geometry.points);
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return null;
  return {
    points: geometry.points,
    distanceMeters,
    elevationProfile: profileFromGeometry(geometry, elevationProfileOverride),
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
 * A null result means the geometry is incomplete or the routes are not equivalent.
 */
export function evaluateRouteMatch(input: RouteMatchInput): RouteMatchEvidence | null {
  const left = prepareRoute(input.left, input.left_distance_meters, input.left_elevation_profile);
  const right = prepareRoute(
    input.right,
    input.right_distance_meters,
    input.right_elevation_profile,
  );
  if (left === null || right === null) return null;

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
  if (rejectionReasons.length > 0) return null;

  return {
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
    rejection_reasons: [],
  };
}
