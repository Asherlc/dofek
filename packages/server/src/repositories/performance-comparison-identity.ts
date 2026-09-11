import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, type SqlExecutor } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  type IdentityEquivalence,
  isIdentityEquivalence,
  type PerformanceEquivalence,
  type ResolvedEquivalence,
} from "./performance-comparison-types.ts";
import { rankEquivalenceStrength } from "./repeated-effort-identity.ts";
import {
  EFFORT_IDENTITY_KINDS,
  EQUIVALENCE_STRENGTHS,
  type EquivalenceStrength,
  type WeakEffortSpecification,
  weakDurationBucket,
} from "./repeated-effort-types.ts";
import { evaluateRouteMatch } from "./route-equivalence.ts";

export const comparisonIdentityRowSchema = z.strictObject({
  canonical_activity_id: z.uuid(),
  source_activity_id: z.uuid(),
  source_provider: z.string(),
  source_external_id: z.string().nullable(),
  kind: z.enum(EFFORT_IDENTITY_KINDS),
  namespace: z.string().nullable(),
  value: z.string(),
  normalized_value: z.string(),
  display_name: z.string().nullable(),
  strength: z.enum(EQUIVALENCE_STRENGTHS),
  method: z.string(),
  source_field: z.string().nullable(),
  evidence: z.record(z.string(), z.unknown()),
});
export type ComparisonIdentityRow = z.infer<typeof comparisonIdentityRowSchema>;
const routeSchema = z.object({
  canonical_activity_id: z.uuid(),
  route_fingerprint: z.string().nullable(),
  points: z.array(z.tuple([z.number(), z.number()])).max(64),
  route_distance_meters: z.number().nullable(),
  elevation_profile: z.array(z.number()),
  coverage_pct: z.number().nullable(),
  largest_gap_seconds: z.number().nullable(),
  geometry_status: z.enum(["available", "partial", "unavailable"]),
  source_providers: z.array(z.string()),
  source_devices: z.array(z.string()),
});
type Route = z.infer<typeof routeSchema>;
type Activity = {
  activity_id: string;
  member_activity_ids: string[];
  canonical_type: string;
  modality: string | null;
};
const geometry = (route: Route) => ({
  points: route.points.map(([lat, lng]) => ({ lat, lng })),
  distance_meters: route.route_distance_meters,
  elevation_profile: route.elevation_profile,
  geometry_status: route.geometry_status,
  coverage_pct: route.coverage_pct,
  largest_gap_seconds: route.largest_gap_seconds,
});
const routeQuality = (route: Route) => ({
  geometry_status: route.geometry_status,
  coverage_pct: route.coverage_pct,
  largest_gap_seconds: route.largest_gap_seconds,
});

/** Serving identity evidence, fenced by the caller's authorized canonical membership. */
export class PerformanceComparisonIdentity {
  readonly #db: SqlExecutor;
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #userId: string;
  constructor(db: SqlExecutor, store: Pick<ActivitySensorStore, "query">, userId: string) {
    this.#db = db;
    this.#store = store;
    this.#userId = userId;
  }

  async identities(activities: Activity[]) {
    if (!activities.length) return [];
    const rows = await this.#store.query(
      comparisonIdentityRowSchema,
      `/* performance-comparison:identities */
      SELECT canonical_activity_id, source_activity_id, source_provider, source_external_id,
        kind, namespace, value, normalized_value, display_name, strength, method, source_field, evidence
      FROM analytics.activity_effort_identity FINAL
      WHERE user_id = {userId:UUID} AND is_deleted = 0
        AND canonical_activity_id IN {activityIds:Array(UUID)} LIMIT 20001`,
      { userId: this.#userId, activityIds: activities.map((a) => a.activity_id) },
    );
    if (rows.length > 20000)
      throw new Error("Too many identity records; narrow the comparison date range.");
    return rows.filter(
      (row) =>
        activities.some(
          (a) =>
            a.activity_id === row.canonical_activity_id &&
            a.member_activity_ids.includes(row.source_activity_id),
        ) && row.value.trim(),
    );
  }

  strongest(rows: ComparisonIdentityRow[]): IdentityEquivalence | null {
    const strong = rows.filter(
      (r) =>
        r.namespace &&
        ["exact", "strong_inferred"].includes(r.strength) &&
        ["provider_workout", "standardized_test", "provider_route", "segment", "climb"].includes(
          r.kind,
        ),
    );
    // Conflicting source values are never silently resolved by priority.
    for (const row of strong.filter((r) => r.strength === "exact")) {
      if (
        strong.some(
          (other) =>
            other.strength === "exact" &&
            other.kind === row.kind &&
            other.namespace === row.namespace &&
            other.value !== row.value,
        )
      )
        throw new Error(
          "Conflicting exact identities; provide an explicit equivalence key with a specific namespace and value.",
        );
    }
    const priority = [
      "provider_workout",
      "standardized_test",
      "provider_route",
      "segment",
      "climb",
    ];
    strong.sort(
      (a, b) =>
        rankEquivalenceStrength(b.strength, a.strength) ||
        priority.indexOf(a.kind) - priority.indexOf(b.kind),
    );
    const best = strong[0];
    if (!best?.namespace) return null;
    if (
      strong.some(
        (other) =>
          other.kind === best.kind &&
          other.strength === best.strength &&
          (other.namespace !== best.namespace || other.value !== best.value),
      )
    )
      throw new Error(
        "Ambiguous exact identities; provide an explicit equivalence key with a specific namespace and value.",
      );
    if (best.kind === "provider_workout" || best.kind === "provider_route")
      return { kind: best.kind, provider: best.namespace, value: best.value };
    if (best.kind === "segment" || best.kind === "climb" || best.kind === "standardized_test")
      return { kind: best.kind, namespace: best.namespace, value: best.value };
    return null;
  }

  matchingWeak(
    specification: WeakEffortSpecification,
    rows: ComparisonIdentityRow[],
    activities: Array<Activity & { started_at: string; ended_at: string | null }>,
  ): ComparisonIdentityRow[] {
    const eligibleIds = new Set(
      activities
        .filter((activity) => {
          const durationBucket = activity.ended_at
            ? weakDurationBucket(activity.started_at, activity.ended_at)
            : null;
          return (
            activity.canonical_type === specification.canonicalType &&
            activity.modality === specification.modality &&
            durationBucket === specification.durationBucket
          );
        })
        .map((activity) => activity.activity_id),
    );
    return rows.filter(
      (row) =>
        row.kind === "activity_name" &&
        row.namespace === specification.namespace &&
        row.normalized_value === specification.normalizedValue &&
        eligibleIds.has(row.canonical_activity_id),
    );
  }

  matching(key: IdentityEquivalence, rows: ComparisonIdentityRow[]) {
    const kind = key.kind === "provider_workout_id" ? "provider_workout" : key.kind;
    const namespace = "provider" in key ? key.provider : "namespace" in key ? key.namespace : null;
    return rows.filter(
      (r) => r.kind === kind && r.namespace === namespace && r.value === key.value,
    );
  }

  async routes(activities: Activity[]) {
    if (!activities.length) return [];
    const rows = await this.#store.query(
      routeSchema,
      `/* performance-comparison:routes */
      SELECT canonical_activity_id, route_fingerprint, points, route_distance_meters,
        elevation_profile, coverage_pct, largest_gap_seconds, geometry_status, source_providers, source_devices
      FROM analytics.activity_route_identity FINAL
      WHERE user_id = {userId:UUID} AND is_deleted = 0
        AND canonical_activity_id IN {activityIds:Array(UUID)} ORDER BY canonical_activity_id LIMIT 251`,
      { userId: this.#userId, activityIds: activities.map((a) => a.activity_id) },
    );
    if (rows.length > 250)
      throw new Error("Too many route candidates; narrow the comparison date range.");
    return rows.filter((r) => activities.some((a) => a.activity_id === r.canonical_activity_id));
  }

  routeMatches(value: string, routes: Route[], activities: Activity[]) {
    return this.routeEvidence(value, routes, activities).filter((row) => row.geometry?.matched);
  }

  routeEvidence(value: string, routes: Route[], activities: Activity[]) {
    const anchor = routes.find(
      (r) => r.canonical_activity_id === value || r.route_fingerprint === value,
    );
    if (!anchor)
      throw new Error(
        "Canonical route anchor is unavailable in the selected range; use a discovery anchor activity ID or stored fingerprint.",
      );
    const anchorActivity = activities.find((a) => a.activity_id === anchor.canonical_activity_id);
    return routes.flatMap((route) => {
      const activity = activities.find((a) => a.activity_id === route.canonical_activity_id);
      if (
        activity?.canonical_type !== anchorActivity?.canonical_type ||
        activity?.modality !== anchorActivity?.modality
      )
        return [];
      const match = evaluateRouteMatch({ left: geometry(anchor), right: geometry(route) });
      return [
        {
          activityId: route.canonical_activity_id,
          geometry: match,
          geometry_unavailable_reason: match
            ? null
            : anchor.geometry_status !== "available" || route.geometry_status !== "available"
              ? `Route geometry comparison requires available geometry; anchor is ${anchor.geometry_status}, candidate is ${route.geometry_status}.`
              : "Anchor or candidate route geometry has insufficient valid points or a non-positive distance.",
          quality: routeQuality(route),
          anchor_quality: routeQuality(anchor),
          anchor_activity_id: anchor.canonical_activity_id,
          source_providers: route.source_providers,
          source_devices: route.source_devices,
          anchor_source_providers: anchor.source_providers,
          anchor_source_devices: anchor.source_devices,
        },
      ];
    });
  }

  async benchmark(value: string) {
    return executeWithSchema(
      this.#db,
      z.object({
        canonical_activity_id: z.uuid(),
        display_name: z.string(),
        notes: z.string().nullable(),
        inclusion_note: z.string().nullable(),
      }),
      sql`/* performance-comparison:benchmark */
      SELECT m.canonical_activity_id, g.display_name, g.notes, m.inclusion_note
      FROM fitness.effort_equivalence_group g
      JOIN fitness.effort_equivalence_group_member m ON m.group_id = g.id AND m.user_id = g.user_id
      WHERE g.user_id = ${this.#userId}::uuid AND m.user_id = ${this.#userId}::uuid AND g.id = ${value}::uuid
      ORDER BY m.canonical_activity_id LIMIT 2001`,
    );
  }
}

const unique = (values: string[]) => [...new Set(values)];
export function resolveFromReference(row: {
  canonical_type: string;
  exercise_ids: string[];
  climb_identities: Array<Omit<Extract<PerformanceEquivalence, { climbType: string }>, "kind">>;
}): ResolvedEquivalence {
  const climbIdentities = row.climb_identities.filter(
    (identity, index, all) =>
      all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(identity)) ===
      index,
  );
  if (row.canonical_type === "climbing" && climbIdentities.length === 1) {
    const identity = climbIdentities[0];
    if (!identity) throw new Error("Climb identity unexpectedly missing");
    return {
      key: { kind: "climb", ...identity },
      basis: "derived_from_reference",
      method: "exact_climb_location_route_grade_identity",
      confidence: "high",
      assumptions: [],
    };
  }
  const exerciseIds = unique(row.exercise_ids);
  if (row.canonical_type === "strength" && exerciseIds.length === 1) {
    const exerciseId = exerciseIds[0];
    if (!exerciseId) throw new Error("Strength exercise identity unexpectedly missing");
    return {
      key: { kind: "strength_exercise_id", exerciseId },
      basis: "derived_from_reference",
      method: "exact_normalized_strength_exercise_identity",
      confidence: "high",
      assumptions: [],
    };
  }
  throw new Error(
    "The reference activity has no single defensible equivalence identity; provide an explicit equivalence key instead of comparing unrelated performances.",
  );
}

export function resolveExplicit(key: PerformanceEquivalence): ResolvedEquivalence {
  if (isIdentityEquivalence(key)) {
    return {
      key,
      basis: "explicit",
      method: "identity_read_model",
      confidence: "high",
      assumptions: [],
    };
  }
  if (key.kind === "activity_name") {
    return {
      key,
      basis: "explicit",
      method: key.weakSpecification
        ? "discovery_weak_name_type_modality_duration"
        : "exact_normalized_activity_name",
      confidence: "user_asserted",
      assumptions: [
        key.weakSpecification
          ? "Discovery requires the same identity namespace, normalized name, canonical type, modality and five-minute elapsed-duration bucket; this is weak similarity only."
          : key.asserted === false
            ? "Normalized name and canonical type are weak similarity only."
            : "The caller asserted that activities with this exact normalized name and canonical type are equivalent.",
      ],
    };
  }
  if (key.kind === "cycling_route" || key.kind === "standardized_test") {
    return {
      key,
      basis: "explicit",
      method:
        key.kind === "cycling_route"
          ? "caller_asserted_cycling_route_name_provider_type"
          : "caller_asserted_standardized_test_name_provider_type",
      confidence: "user_asserted",
      assumptions: [
        "The caller asserted that this provider-scoped activity name and provider type denote equivalent performances.",
      ],
    };
  }
  const method = {
    climb: "exact_climb_location_route_grade_identity",
    strength_exercise_id: "exact_normalized_strength_exercise_identity",
  }[key.kind];
  return { key, basis: "explicit", method, confidence: "high", assumptions: [] };
}

/** Describe the actual evidence level without promoting inferred identities to exact. */
export function describeComparisonEvidence(
  equivalence: {
    key: PerformanceEquivalence;
    basis: "derived_from_reference" | "explicit";
    method: string;
    confidence: "high" | "user_asserted";
    assumptions: string[];
  },
  identityRows: ComparisonIdentityRow[],
  userId: string,
  activityId?: string,
) {
  const modelKey = isIdentityEquivalence(equivalence.key) ? equivalence.key : null;
  const identityKind =
    modelKey?.kind === "provider_workout_id" ? "provider_workout" : equivalence.key.kind;
  const identityValue =
    "value" in equivalence.key
      ? equivalence.key.value
      : equivalence.key.kind === "strength_exercise_id"
        ? equivalence.key.exerciseId
        : JSON.stringify(equivalence.key);
  const identityNamespace =
    modelKey && "provider" in modelKey
      ? modelKey.provider
      : modelKey && "namespace" in modelKey
        ? modelKey.namespace
        : modelKey?.kind === "canonical_route"
          ? "route_geometry_v1"
          : modelKey?.kind === "user_defined_benchmark"
            ? userId
            : equivalence.key.kind === "activity_name"
              ? equivalence.key.weakSpecification
                ? equivalence.key.weakSpecification.namespace
                : equivalence.key.canonicalType
              : null;
  const defaultStrength: EquivalenceStrength =
    modelKey?.kind === "canonical_route"
      ? "strong_inferred"
      : modelKey?.kind === "user_defined_benchmark"
        ? "caller_asserted"
        : equivalence.key.kind === "activity_name" &&
            (equivalence.key.asserted === false || equivalence.key.weakSpecification)
          ? "weak_similarity"
          : equivalence.confidence === "user_asserted"
            ? "caller_asserted"
            : "exact";
  const strengthFor = (activityId?: string): EquivalenceStrength => {
    if (equivalence.key.kind === "activity_name" && equivalence.key.weakSpecification)
      return "weak_similarity";
    const rows = activityId
      ? identityRows.filter((row) => row.canonical_activity_id === activityId)
      : identityRows;
    // A merged activity uses its strongest evidence; a comparison uses its weakest member.
    if (!rows.length) return defaultStrength;
    const strengths = activityId
      ? rows.map((row) => row.strength)
      : unique(rows.map((row) => row.canonical_activity_id)).map((id) => strengthFor(id));
    return (
      strengths.sort((a, b) =>
        activityId ? rankEquivalenceStrength(b, a) : rankEquivalenceStrength(a, b),
      )[0] ?? defaultStrength
    );
  };
  const strength = strengthFor(activityId);
  return {
    identity: { kind: identityKind, namespace: identityNamespace, value: identityValue },
    strength,
    basis:
      strength === "caller_asserted"
        ? ("caller_asserted" as const)
        : strength === "weak_similarity"
          ? ("weak_similarity" as const)
          : equivalence.basis,
    confidence:
      strength === "exact"
        ? ("high" as const)
        : strength === "strong_inferred"
          ? ("inferred" as const)
          : strength === "caller_asserted"
            ? ("user_asserted" as const)
            : ("low" as const),
    method:
      modelKey?.kind === "canonical_route"
        ? "route_geometry_v1"
        : modelKey?.kind === "user_defined_benchmark"
          ? "user_benchmark_membership"
          : modelKey
            ? unique(
                identityRows
                  .filter((r) => !activityId || r.canonical_activity_id === activityId)
                  .map((r) => r.method),
              ).join(", ")
            : equivalence.method,
    assumptions: [
      ...equivalence.assumptions,
      "Ordinary workout best is lower-bound observed capability, not maximal capacity. Only standardized/maximal tests or controlled equivalent efforts with comparable conditions support decline conclusions; identity alone does not establish maximal intent.",
      ...(strength === "strong_inferred"
        ? [
            identityKind === "canonical_route"
              ? "Route equivalence is geometric inference; inspect direction, overlap, gaps and elevation evidence."
              : "Identity is inferred; inspect the recorded method and source evidence.",
          ]
        : []),
      ...(strength === "weak_similarity"
        ? ["Normalized-name similarity does not establish equivalent efforts."]
        : []),
      ...(strength === "caller_asserted"
        ? ["Equivalence is asserted by the caller or benchmark owner, not independently verified."]
        : []),
      ...(identityKind === "segment" || identityKind === "climb"
        ? [
            "Metrics describe the containing activity; segment-specific boundaries are not implied by identity.",
          ]
        : []),
    ],
  };
}
