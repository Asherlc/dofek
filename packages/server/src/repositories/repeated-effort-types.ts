export const EFFORT_IDENTITY_KINDS = [
  "provider_workout",
  "provider_route",
  "canonical_route",
  "climb",
  "segment",
  "standardized_test",
  "activity_name",
  "user_defined_benchmark",
] as const;

export type EffortIdentityKind = (typeof EFFORT_IDENTITY_KINDS)[number];

export const EQUIVALENCE_STRENGTHS = [
  "exact",
  "strong_inferred",
  "caller_asserted",
  "weak_similarity",
] as const;

export type EquivalenceStrength = (typeof EQUIVALENCE_STRENGTHS)[number];

/** Source-level evidence for a reusable effort identity. */
export interface EffortIdentityEvidence {
  user_id: string;
  canonical_activity_id: string;
  source_activity_id: string;
  source_provider: string;
  source_external_id: string;
  kind: EffortIdentityKind;
  namespace: string | null;
  value: string;
  normalized_value: string;
  display_name: string | null;
  strength: EquivalenceStrength;
  method: string;
  source_field: string | null;
  evidence: Record<string, unknown>;
  source_refreshed_at: string;
  is_deleted: 0 | 1;
}

/** A reusable identity; it deliberately excludes a provider activity instance ID. */
export interface RepeatedEffortKey {
  kind: EffortIdentityKind;
  namespace: string | null;
  value: string;
}

export type RouteDirection = "forward" | "reverse" | "unknown";

/** A bounded, ordered point from a normalized route serving model. */
export interface NormalizedRoutePoint {
  lat: number;
  lng: number;
  elevation_meters?: number | null;
}

export interface RouteGeometry {
  points: readonly NormalizedRoutePoint[];
  distance_meters?: number | null;
  elevation_profile?: readonly number[] | null;
  geometry_status?: "available" | "partial" | "unavailable";
  /** Percent of observed route time covered by non-gap intervals (0–100). */
  coverage_pct?: number | null;
  largest_gap_seconds?: number | null;
}

/** Stored quality evidence; null means the caller did not supply the observation. */
export interface RouteQualityEvidence {
  geometry_status: NonNullable<RouteGeometry["geometry_status"]> | null;
  coverage_pct: number | null;
  largest_gap_seconds: number | null;
}

export interface RouteMatchInput {
  left: readonly NormalizedRoutePoint[] | RouteGeometry;
  right: readonly NormalizedRoutePoint[] | RouteGeometry;
  left_distance_meters?: number | null;
  right_distance_meters?: number | null;
  left_elevation_profile?: readonly number[] | null;
  right_elevation_profile?: readonly number[] | null;
}

interface RouteMatchEvidenceBase {
  left_quality: RouteQualityEvidence;
  right_quality: RouteQualityEvidence;
  direction: RouteDirection;
  overlap_percentage: number;
  distance_difference: number;
  start_tolerance_meters: number;
  end_tolerance_meters: number;
  elevation_similarity: number | null;
  confidence: number;
}

export interface AcceptedRouteMatchEvidence extends RouteMatchEvidenceBase {
  matched: true;
  strength: "strong_inferred";
  rejection_reasons: readonly [];
}

export interface RejectedRouteMatchEvidence extends RouteMatchEvidenceBase {
  matched: false;
  rejection_reasons: readonly string[];
}

export type RouteMatchEvidence = AcceptedRouteMatchEvidence | RejectedRouteMatchEvidence;
