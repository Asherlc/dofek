import { z } from "zod";

/** Complete key for discovery's weak name/type/modality/five-minute groups. */
export const weakEffortSpecificationSchema = z.strictObject({
  namespace: z.string().nullable(),
  normalizedValue: z.string().min(1),
  canonicalType: z.string().min(1),
  modality: z.string().nullable(),
  durationBucket: z.number().int().nonnegative(),
});
export type WeakEffortSpecification = z.infer<typeof weakEffortSpecificationSchema>;

/** Discovery and comparison use whole timestamp seconds for weak-effort duration buckets. */
export function weakDurationBucket(startedAt: string, endedAt: string): number | null {
  const startedSeconds = Math.floor(Date.parse(startedAt) / 1_000);
  const endedSeconds = Math.floor(Date.parse(endedAt) / 1_000);
  const elapsedSeconds = endedSeconds - startedSeconds;
  return Number.isFinite(elapsedSeconds) && elapsedSeconds > 0
    ? Math.floor(elapsedSeconds / 300)
    : null;
}

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

/** A reusable identity; it deliberately excludes a provider activity instance ID. */
export interface RepeatedEffortKey {
  kind: EffortIdentityKind;
  namespace: string | null;
  value: string;
}

export type {
  AcceptedRouteMatchEvidence,
  NormalizedRoutePoint,
  RejectedRouteMatchEvidence,
  RouteDirection,
  RouteGeometry,
  RouteMatchEvidence,
  RouteMatchInput,
  RouteQualityEvidence,
} from "@dofek/training/route-equivalence";
