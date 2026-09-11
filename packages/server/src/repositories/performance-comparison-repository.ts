import { createHash } from "node:crypto";
import type { Database } from "dofek/db";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import {
  postgresActivityDateIsAuthoritative,
  postgresActivityLocalDate,
} from "./activity-local-date.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { loadCyclingEffortMetrics } from "./cycling-effort-metrics.ts";
import {
  buildActivitySourceSummary,
  buildEquivalenceEvidence,
  buildMovingDuration,
  buildRouteContext,
  buildSampleSourceSummary,
  cyclingEffortRequest,
  hasObservedCyclingSensorData,
  PELOTON_WORKOUT_KEYS,
  PERFORMANCE_COMPARISON_SENSOR_QUERY,
} from "./performance-comparison-context.ts";
import {
  type ClimbingComparisonRow,
  computeClimbingComparisonMetrics,
  computeStrengthComparisonMetrics,
  type StrengthComparisonRow,
} from "./performance-comparison-modality-metrics.ts";
import type { PerformanceEquivalence } from "./performance-comparison-types.ts";

const sourceExternalIdSchema = z.object({
  providerId: z.string(),
  externalId: z.string(),
  memberActivityId: z.string().optional(),
  subsource: z.string().nullable().optional(),
});

const sourceRawEvidenceSchema = z.object({
  sourceActivityId: z.string().uuid(),
  provider: z.string(),
  providerType: z.string().optional().default(""),
  sourceActivityName: z.string().nullable().optional().default(null),
  raw: z.record(z.string(), z.unknown()).nullable(),
});

const climbIdentitySchema = z.object({
  climbType: z.string(),
  gradeSystem: z.string(),
  grade: z.string(),
  routeName: z.string(),
  locationName: z.string(),
  lead: z.boolean().nullable(),
});

const activityRowSchema = z.object({
  activity_id: z.string().uuid(),
  canonical_type: z.string(),
  activity_name: z.string().nullable(),
  modality: z.string().nullable(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  local_date: dateStringSchema,
  source_providers: z.array(z.string()),
  source_external_ids: z.array(sourceExternalIdSchema).nullable().default(null),
  member_activity_ids: z.array(z.string().uuid()),
  timezone: z.string().nullable(),
  start_utc_offset_minutes: z.coerce.number().int().nullable(),
  local_time_source: z.string(),
  date_was_authoritative: z.coerce.boolean(),
  source_raw_evidence: z.array(sourceRawEvidenceSchema),
  exercise_ids: z.array(z.string().uuid()),
  climb_identities: z.array(climbIdentitySchema),
});

const sensorRowSchema = z.object({
  activity_id: z.string().uuid(),
  average_power: z.coerce.number().nullable(),
  normalized_power: z.coerce.number().nullable(),
  average_heart_rate: z.coerce.number().nullable(),
  max_heart_rate: z.coerce.number().nullable(),
  average_cadence: z.coerce.number().nullable(),
  distance_meters: z.coerce.number().nullable(),
  elevation_gain_meters: z.coerce.number().nullable(),
  average_temperature_c: z.coerce.number().nullable(),
  sample_source_providers: z.array(z.string()),
  sample_device_ids: z.array(z.string()),
  sample_count: z.coerce.number().int().nonnegative().nullable(),
  power_sample_count: z.coerce.number().int().nonnegative().nullable(),
  heart_rate_sample_count: z.coerce.number().int().nonnegative().nullable(),
});

const climbingRowSchema = z.object({
  activity_id: z.string().uuid(),
  entry_id: z.string().uuid(),
  entry_activity_id: z.string().uuid(),
  entry_provider: z.string(),
  external_id: z.string().nullable(),
  climb_type: z.string(),
  grade_system: z.string(),
  grade: z.string(),
  sent: z.boolean().nullable(),
  attempt_count: z.coerce.number().int().positive().nullable(),
  lead: z.boolean().nullable(),
  wall_angle_degrees: z.coerce.number().nullable(),
  route_name: z.string().nullable(),
  location_name: z.string().nullable(),
});

const strengthRowSchema = z.object({
  activity_id: z.string().uuid(),
  set_id: z.string().uuid(),
  set_activity_id: z.string().uuid(),
  set_provider: z.string(),
  exercise_id: z.string().uuid(),
  exercise_index: z.coerce.number().int().optional().default(0),
  set_index: z.coerce.number().int().optional().default(0),
  set_type: z.string().nullable(),
  weight_kg: z.coerce.number().nullable(),
  reps: z.coerce.number().int().nullable(),
  rpe: z.coerce.number().nullable(),
});

const cursorSchema = z
  .object({
    version: z.literal(1),
    userId: z.string().uuid(),
    shape: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
    activityId: z.string().uuid(),
  })
  .strict();

type ActivityRow = z.infer<typeof activityRowSchema>;

export interface PerformanceComparisonInput {
  startDate: string;
  endDate: string;
  referenceActivityId: string | null;
  equivalence: PerformanceEquivalence | null;
  providers: string[];
  modalities: string[];
  cursor: string | null;
  limit: number;
}

interface ResolvedEquivalence {
  key: PerformanceEquivalence;
  basis: "derived_from_reference" | "explicit";
  method: string;
  confidence: "high" | "user_asserted";
  assumptions: string[];
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function rawIdentity(
  row: ActivityRow,
  keys: readonly string[],
): Array<{ provider: string; value: string }> {
  const identities: Array<{ provider: string; value: string }> = [];
  for (const evidence of row.source_raw_evidence) {
    if (!evidence.raw) continue;
    for (const key of keys) {
      const value = evidence.raw[key];
      if (typeof value === "string" && value.trim().length > 0) {
        identities.push({ provider: evidence.provider, value: value.trim() });
      }
    }
  }
  return identities.filter(
    (identity, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.provider === identity.provider && candidate.value === identity.value,
      ) === index,
  );
}

function resolveFromReference(row: ActivityRow): ResolvedEquivalence {
  const workout = rawIdentity(row, PELOTON_WORKOUT_KEYS).filter(
    (identity) => identity.provider === "peloton",
  );
  const workoutIdentity = workout.length === 1 ? workout[0] : undefined;
  if (workoutIdentity) {
    return {
      key: { kind: "provider_workout_id", provider: "peloton", value: workoutIdentity.value },
      basis: "derived_from_reference",
      method: "exact_provider_workout_identity",
      confidence: "high",
      assumptions: [],
    };
  }
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

function resolveExplicit(key: PerformanceEquivalence): ResolvedEquivalence {
  if (key.kind === "activity_name") {
    return {
      key,
      basis: "explicit",
      method: "exact_normalized_activity_name",
      confidence: "user_asserted",
      assumptions: [
        "The caller asserted that activities with this exact normalized name and canonical type are equivalent.",
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
    provider_workout_id: "exact_provider_workout_identity",
    climb: "exact_climb_location_route_grade_identity",
    strength_exercise_id: "exact_normalized_strength_exercise_identity",
  }[key.kind];
  return { key, basis: "explicit", method, confidence: "high", assumptions: [] };
}

function rawKeyPredicate(provider: string | null, value: string, keys: readonly string[]): SQL {
  const valuePredicates = keys.map((key) => sql`btrim(source_activity.raw->>${key}) = ${value}`);
  const providerPredicate =
    provider === null ? sql`true` : sql`source_activity.provider_id = ${provider}`;
  return sql`EXISTS (
    SELECT 1
    FROM fitness.activity AS source_activity
    WHERE source_activity.id = ANY(a.member_activity_ids)
      AND ${providerPredicate}
      AND (${sql.join(valuePredicates, sql` OR `)})
  )`;
}

function equivalencePredicate(key: PerformanceEquivalence): SQL {
  if (key.kind === "provider_workout_id") {
    return rawKeyPredicate(key.provider, key.value, PELOTON_WORKOUT_KEYS);
  }
  if (key.kind === "cycling_route" || key.kind === "standardized_test") {
    return sql`EXISTS (
      SELECT 1
      FROM fitness.activity AS source_activity
      WHERE source_activity.id = ANY(a.member_activity_ids)
        AND source_activity.provider_id = ${key.provider}
        AND lower(regexp_replace(btrim(source_activity.name), '\\s+', ' ', 'g')) = ${normalized(key.activityName)}
        AND lower(regexp_replace(btrim(source_activity.provider_type), '\\s+', ' ', 'g')) = ${normalized(key.providerType)}
        ${key.kind === "cycling_route" ? sql`AND source_activity.canonical_type::text = 'cycling'` : sql``}
    )`;
  }
  if (key.kind === "strength_exercise_id") {
    return sql`EXISTS (
      SELECT 1 FROM fitness.strength_set AS matched_set
      WHERE matched_set.activity_id = ANY(a.member_activity_ids)
        AND matched_set.exercise_id = ${key.exerciseId}::uuid
    )`;
  }
  if (key.kind === "climb") {
    return sql`EXISTS (
      SELECT 1 FROM fitness.climbing_entry AS matched_climb
      WHERE matched_climb.activity_id = ANY(a.member_activity_ids)
        AND matched_climb.climb_type::text = ${key.climbType}
        AND matched_climb.grade_system::text = ${key.gradeSystem}
        AND lower(regexp_replace(btrim(matched_climb.grade), '\\s+', ' ', 'g')) = ${normalized(key.grade)}
        AND lower(regexp_replace(btrim(matched_climb.route_name), '\\s+', ' ', 'g')) = ${normalized(key.routeName)}
        AND lower(regexp_replace(btrim(matched_climb.location_name), '\\s+', ' ', 'g')) = ${normalized(key.locationName)}
        AND matched_climb.lead IS NOT DISTINCT FROM ${key.lead}
    )`;
  }
  return sql`a.canonical_type::text = ${key.canonicalType}
    AND lower(regexp_replace(btrim(a.name), '\\s+', ' ', 'g')) = ${normalized(key.value)}`;
}

function filterPredicate(input: PerformanceComparisonInput): SQL {
  const providers =
    input.providers.length === 0
      ? sql`true`
      : sql`a.source_providers && ARRAY[${sql.join(
          input.providers.map((provider) => sql`${provider}`),
          sql`, `,
        )}]::text[]`;
  const modalities =
    input.modalities.length === 0
      ? sql`true`
      : sql`a.modality::text IN (${sql.join(
          input.modalities.map((modality) => sql`${modality}`),
          sql`, `,
        )})`;
  return sql`${providers} AND ${modalities}`;
}

function activitySelect(
  userId: string,
  timezone: string,
  where: SQL,
  marker: string,
  orderAndLimit: SQL,
): SQL {
  const localDate = postgresActivityLocalDate(sql`a`, timezone);
  const authoritativeDate = postgresActivityDateIsAuthoritative(sql`a`);
  return sql`${sql.raw(`/* ${marker} */`)}
    SELECT
      a.id::text AS activity_id,
      a.canonical_type::text AS canonical_type,
      a.name AS activity_name,
      a.modality::text AS modality,
      a.started_at::text AS started_at,
      a.ended_at::text AS ended_at,
      (${localDate})::text AS local_date,
      a.source_providers,
      a.source_external_ids,
      a.member_activity_ids,
      a.timezone,
      a.start_utc_offset_minutes,
      a.local_time_source,
      ${authoritativeDate} AS date_was_authoritative,
      COALESCE(source_evidence.rows, '[]'::jsonb) AS source_raw_evidence,
      COALESCE(strength_evidence.exercise_ids, ARRAY[]::text[]) AS exercise_ids,
      COALESCE(climb_evidence.identities, '[]'::jsonb) AS climb_identities
    FROM fitness.v_activity AS a
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'sourceActivityId', source_activity.id,
        'provider', source_activity.provider_id,
        'providerType', source_activity.provider_type,
        'sourceActivityName', source_activity.name,
        'raw', source_activity.raw
      ) ORDER BY source_activity.provider_id, source_activity.id) AS rows
      FROM fitness.activity AS source_activity
      WHERE source_activity.id = ANY(a.member_activity_ids)
    ) AS source_evidence ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT strength.exercise_id::text ORDER BY strength.exercise_id::text)
        AS exercise_ids
      FROM fitness.strength_set AS strength
      WHERE strength.activity_id = ANY(a.member_activity_ids)
    ) AS strength_evidence ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(DISTINCT jsonb_build_object(
        'climbType', climb.climb_type,
        'gradeSystem', climb.grade_system,
        'grade', lower(regexp_replace(btrim(climb.grade), '\\s+', ' ', 'g')),
        'routeName', lower(regexp_replace(btrim(climb.route_name), '\\s+', ' ', 'g')),
        'locationName', lower(regexp_replace(btrim(climb.location_name), '\\s+', ' ', 'g')),
        'lead', climb.lead
      )) FILTER (WHERE climb.route_name IS NOT NULL AND climb.location_name IS NOT NULL)
        AS identities
      FROM fitness.climbing_entry AS climb
      WHERE climb.activity_id = ANY(a.member_activity_ids)
    ) AS climb_evidence ON true
    WHERE a.user_id = ${userId}::uuid
      AND ${where}
    ${orderAndLimit}`;
}

function outputKey(key: PerformanceEquivalence) {
  if (key.kind === "activity_name") {
    return { kind: key.kind, canonical_type: key.canonicalType, value: key.value };
  }
  if (key.kind === "strength_exercise_id") {
    return { kind: key.kind, exercise_id: key.exerciseId };
  }
  if (key.kind === "climb") {
    return {
      kind: key.kind,
      climb_type: key.climbType,
      grade_system: key.gradeSystem,
      grade: key.grade,
      route_name: key.routeName,
      location_name: key.locationName,
      lead: key.lead,
    };
  }
  if (key.kind === "cycling_route" || key.kind === "standardized_test") {
    return {
      kind: key.kind,
      provider: key.provider,
      activity_name: key.activityName,
      provider_type: key.providerType,
    };
  }
  return key;
}

function shapeFor(
  input: PerformanceComparisonInput,
  equivalence: PerformanceEquivalence,
  timezone: string,
  baselineActivityId: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        startDate: input.startDate,
        endDate: input.endDate,
        equivalence,
        referenceActivityId: input.referenceActivityId,
        baselineActivityId,
        providers: [...input.providers].sort(),
        modalities: [...input.modalities].sort(),
        timezone,
      }),
    )
    .digest("hex");
}

function decodeCursor(cursor: string | null, userId: string, shape: string) {
  if (!cursor) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("Invalid performance comparison cursor", { cause: error });
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.userId !== userId || parsed.data.shape !== shape) {
    throw new Error("Performance comparison cursor does not match this query");
  }
  return parsed.data;
}

function encodeCursor(userId: string, shape: string, row: ActivityRow): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      userId,
      shape,
      startedAt: row.started_at,
      activityId: row.activity_id,
    }),
  ).toString("base64url");
}

function durationSeconds(row: ActivityRow): number | null {
  if (row.ended_at === null) return null;
  const value = (Date.parse(row.ended_at) - Date.parse(row.started_at)) / 1000;
  return Number.isFinite(value) && value >= 0 ? round(value, 0) : null;
}

function delta(candidate: number | null, baseline: number | null): number | null {
  return candidate === null || baseline === null ? null : round(candidate - baseline);
}

/** Compare only performances linked by an explicit or strongly evidenced equivalence identity. */
export class PerformanceComparisonRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(
    db: Pick<Database, "execute">,
    store: Pick<ActivitySensorStore, "query">,
    userId: string,
    timezone: string,
  ) {
    this.#db = db;
    this.#store = store;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  async #reference(activityId: string): Promise<ActivityRow> {
    const rows = await executeWithSchema(
      this.#db,
      activityRowSchema,
      activitySelect(
        this.#userId,
        this.#timezone,
        sql`a.id = ${activityId}::uuid`,
        "performance-comparison:reference",
        sql`LIMIT 1`,
      ),
    );
    const row = rows[0];
    if (!row) throw new Error("Reference activity was not found for this user");
    return row;
  }

  /** Complete metric contract for the identity-aware comparison pipeline. */
  async cyclingEfforts(activityIds: string[], durationsSeconds: number[]) {
    z.array(z.string().uuid())
      .max(25, "At most 25 cycling activities may be calculated")
      .parse(activityIds);
    z.array(z.number().int().positive().max(21600)).max(32).parse(durationsSeconds);
    const activities = await Promise.all(unique(activityIds).map((id) => this.#reference(id)));
    if (activities.some((activity) => activity.canonical_type !== "cycling")) {
      throw new Error("Cycling effort metrics require canonical cycling activities");
    }
    return loadCyclingEffortMetrics(
      this.#db,
      this.#store,
      this.#userId,
      this.#timezone,
      activities.map(cyclingEffortRequest),
      durationsSeconds,
    );
  }

  async compare(input: PerformanceComparisonInput) {
    if (!input.referenceActivityId && !input.equivalence) {
      throw new Error("A reference activity or explicit equivalence key is required");
    }
    const reference = input.referenceActivityId
      ? await this.#reference(input.referenceActivityId)
      : null;
    let equivalence: ResolvedEquivalence;
    if (input.equivalence) {
      equivalence = resolveExplicit(input.equivalence);
    } else {
      if (!reference) throw new Error("A reference activity is required to derive equivalence");
      equivalence = resolveFromReference(reference);
    }
    const localDate = postgresActivityLocalDate(sql`a`, this.#timezone);
    const range = sql`${localDate} BETWEEN ${input.startDate}::date AND ${input.endDate}::date`;
    const filters = filterPredicate(input);
    const identity = equivalencePredicate(equivalence.key);
    const referenceFilter = input.referenceActivityId
      ? sql`AND a.id = ${input.referenceActivityId}::uuid`
      : sql``;
    const baselineRows = await executeWithSchema(
      this.#db,
      activityRowSchema,
      activitySelect(
        this.#userId,
        this.#timezone,
        sql`${range} AND ${filters} AND ${identity} ${referenceFilter}`,
        "performance-comparison:baseline",
        sql`ORDER BY a.started_at ASC, a.id ASC LIMIT 1`,
      ),
    );
    const baseline = baselineRows[0];
    if (!baseline) {
      throw new Error(
        input.referenceActivityId
          ? "The reference activity does not match the equivalence key, range, or filters"
          : "No performances match the equivalence key, range, and filters",
      );
    }

    const shape = shapeFor(input, equivalence.key, this.#timezone, baseline.activity_id);
    const cursor = decodeCursor(input.cursor, this.#userId, shape);
    const cursorPredicate = cursor
      ? sql`AND (a.started_at, a.id) > (${cursor.startedAt}::timestamptz, ${cursor.activityId}::uuid)`
      : sql``;
    const candidateRows = await executeWithSchema(
      this.#db,
      activityRowSchema,
      activitySelect(
        this.#userId,
        this.#timezone,
        sql`${range} AND ${filters} AND ${identity} ${cursorPredicate}`,
        "performance-comparison:candidates",
        sql`ORDER BY a.started_at ASC, a.id ASC LIMIT ${input.limit + 1}`,
      ),
    );
    const hasMore = candidateRows.length > input.limit;
    const pageRows = candidateRows.slice(0, input.limit);
    const metricActivityIds = unique([...pageRows, baseline].map((row) => row.activity_id));

    const climbingRows = await executeWithSchema(
      this.#db,
      climbingRowSchema,
      sql`/* performance-comparison:climbing */
        SELECT
          a.id::text AS activity_id,
          climb.id::text AS entry_id,
          climb.activity_id::text AS entry_activity_id,
          source_activity.provider_id AS entry_provider,
          climb.external_id,
          climb.climb_type::text AS climb_type,
          climb.grade_system::text AS grade_system,
          climb.grade,
          climb.sent,
          climb.attempt_count,
          climb.lead,
          climb.wall_angle_degrees,
          climb.route_name,
          climb.location_name
        FROM fitness.v_activity AS a
        JOIN fitness.climbing_entry AS climb ON climb.activity_id = ANY(a.member_activity_ids)
        JOIN fitness.activity AS source_activity ON source_activity.id = climb.activity_id
        WHERE a.user_id = ${this.#userId}::uuid
          AND a.id IN (${sql.join(
            metricActivityIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
          ${
            equivalence.key.kind === "climb"
              ? sql`AND climb.climb_type::text = ${equivalence.key.climbType}
                AND climb.grade_system::text = ${equivalence.key.gradeSystem}
                AND lower(regexp_replace(btrim(climb.grade), '\\s+', ' ', 'g')) = ${normalized(equivalence.key.grade)}
                AND lower(regexp_replace(btrim(climb.route_name), '\\s+', ' ', 'g')) = ${normalized(equivalence.key.routeName)}
                AND lower(regexp_replace(btrim(climb.location_name), '\\s+', ' ', 'g')) = ${normalized(equivalence.key.locationName)}
                AND climb.lead IS NOT DISTINCT FROM ${equivalence.key.lead}`
              : sql``
          }
        ORDER BY a.id, climb.id`,
    );
    const strengthRows = await executeWithSchema(
      this.#db,
      strengthRowSchema,
      sql`/* performance-comparison:strength */
        SELECT
          a.id::text AS activity_id,
          strength.id::text AS set_id,
          strength.activity_id::text AS set_activity_id,
          source_activity.provider_id AS set_provider,
          strength.exercise_id::text AS exercise_id,
          strength.exercise_index,
          strength.set_index,
          strength.set_type::text AS set_type,
          strength.weight_kg,
          strength.reps,
          strength.rpe
        FROM fitness.v_activity AS a
        JOIN fitness.strength_set AS strength ON strength.activity_id = ANY(a.member_activity_ids)
        JOIN fitness.activity AS source_activity ON source_activity.id = strength.activity_id
        WHERE a.user_id = ${this.#userId}::uuid
          AND a.id IN (${sql.join(
            metricActivityIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
          ${
            equivalence.key.kind === "strength_exercise_id"
              ? sql`AND strength.exercise_id = ${equivalence.key.exerciseId}::uuid`
              : sql``
          }
        ORDER BY a.id, strength.exercise_index, strength.set_index, strength.id`,
    );
    const sensorRows = await this.#store.query(
      sensorRowSchema,
      PERFORMANCE_COMPARISON_SENSOR_QUERY,
      {
        userId: this.#userId,
        activityIds: metricActivityIds,
      },
    );

    const sensorsByActivity = new Map(sensorRows.map((row) => [row.activity_id, row]));
    const climbsByActivity = new Map<string, ClimbingComparisonRow[]>();
    for (const row of climbingRows) {
      climbsByActivity.set(row.activity_id, [
        ...(climbsByActivity.get(row.activity_id) ?? []),
        row,
      ]);
    }
    const strengthByActivity = new Map<string, StrengthComparisonRow[]>();
    for (const row of strengthRows) {
      strengthByActivity.set(row.activity_id, [
        ...(strengthByActivity.get(row.activity_id) ?? []),
        row,
      ]);
    }

    const values = (row: ActivityRow) => {
      const sensor = sensorsByActivity.get(row.activity_id);
      const sampleCoverageAvailable =
        sensor !== undefined &&
        [sensor.sample_count, sensor.power_sample_count, sensor.heart_rate_sample_count].some(
          (value) => value !== null,
        );
      const cycling =
        row.canonical_type !== "cycling"
          ? null
          : {
              average_power_watts: sensor?.average_power ?? null,
              normalized_power_watts: sensor?.normalized_power ?? null,
              average_heart_rate_bpm: sensor?.average_heart_rate ?? null,
              max_heart_rate_bpm: sensor?.max_heart_rate ?? null,
              average_cadence_rpm: sensor?.average_cadence ?? null,
              power_to_heart_rate_ratio:
                sensor?.average_power == null ||
                sensor.average_heart_rate == null ||
                sensor.average_heart_rate <= 0
                  ? null
                  : round(sensor.average_power / sensor.average_heart_rate),
              distance_meters: sensor?.distance_meters ?? null,
              elevation_gain_meters: sensor?.elevation_gain_meters ?? null,
              sample_coverage: {
                total_samples: sensor?.sample_count ?? null,
                power_samples: sensor?.power_sample_count ?? null,
                heart_rate_samples: sensor?.heart_rate_sample_count ?? null,
                status: sampleCoverageAvailable
                  ? ("available" as const)
                  : ("not_available" as const),
              },
            };
      return {
        duration: durationSeconds(row),
        averageTemperatureC: sensor?.average_temperature_c ?? null,
        cycling,
        climbing: computeClimbingComparisonMetrics(climbsByActivity.get(row.activity_id) ?? []),
        strength: computeStrengthComparisonMetrics(strengthByActivity.get(row.activity_id) ?? []),
      };
    };
    const baselineValues = values(baseline);
    const baselineMovingDuration = buildMovingDuration(baseline.source_raw_evidence);
    const performance = (row: ActivityRow) => {
      const current = values(row);
      const climbingForActivity = climbsByActivity.get(row.activity_id) ?? [];
      const strengthForActivity = strengthByActivity.get(row.activity_id) ?? [];
      const equivalenceEvidence = buildEquivalenceEvidence(equivalence.key, {
        activityId: row.activity_id,
        activityName: row.activity_name,
        sourceRawEvidence: row.source_raw_evidence,
        climbingRows: climbingForActivity,
        strengthRows: strengthForActivity,
      });
      const movingDuration = buildMovingDuration(row.source_raw_evidence);
      const flags = [
        ...(current.duration === null ? ["duration_unavailable"] : []),
        ...(row.local_time_source === "unknown" ? ["timezone_assumed_from_analysis_context"] : []),
        ...(row.canonical_type === "cycling" &&
        !hasObservedCyclingSensorData(row.canonical_type, sensorsByActivity.get(row.activity_id))
          ? ["cycling_sensor_summary_unavailable"]
          : []),
        ...((current.strength?.suspicious_sets ?? 0) > 0
          ? ["contains_suspicious_strength_sets_excluded_from_metrics"]
          : []),
        ...(current.strength?.volume_status === "partial"
          ? ["strength_volume_coverage_partial"]
          : []),
        ...(current.strength?.estimated_one_rep_max_status === "partial"
          ? ["strength_estimated_one_rep_max_coverage_partial"]
          : []),
        ...((current.climbing?.excluded_ambiguous_entries ?? 0) > 0
          ? ["contains_ambiguous_climbing_entries_excluded_from_metrics"]
          : []),
        ...(current.climbing?.attempts_status === "partial"
          ? ["climbing_attempt_coverage_partial"]
          : []),
        ...(current.climbing?.outcomes_status === "partial"
          ? ["climbing_outcome_coverage_partial"]
          : []),
        ...(movingDuration.status === "conflicting" ? ["moving_duration_sources_conflict"] : []),
        ...(equivalenceEvidence.count === 0 ? ["equivalence_evidence_unavailable"] : []),
      ];
      return {
        activity_id: row.activity_id,
        date: row.local_date,
        started_at: row.started_at,
        name: row.activity_name,
        canonical_type: row.canonical_type,
        modality: row.modality,
        duration_seconds: current.duration,
        moving_duration: movingDuration,
        route: buildRouteContext(equivalence.key, row.activity_name),
        equivalence_evidence: equivalenceEvidence.items,
        equivalence_evidence_count: equivalenceEvidence.count,
        equivalence_evidence_truncated: equivalenceEvidence.truncated,
        is_baseline: row.activity_id === baseline.activity_id,
        ...buildActivitySourceSummary(
          row.source_providers,
          row.source_external_ids ?? [],
          row.member_activity_ids,
        ),
        timezone: {
          value: row.timezone,
          start_utc_offset_minutes: row.start_utc_offset_minutes,
          local_time_source: row.local_time_source,
          analysis_timezone: this.#timezone,
          assumed: !row.date_was_authoritative,
        },
        metrics: {
          cycling: current.cycling,
          climbing: current.climbing,
          strength: current.strength,
          environment: {
            average_temperature_c: current.averageTemperatureC,
            status:
              current.averageTemperatureC == null
                ? ("not_available" as const)
                : ("available" as const),
            value_kind: "calculated_from_deduped_samples" as const,
          },
        },
        delta_to_baseline: {
          duration_seconds: delta(current.duration, baselineValues.duration),
          moving_duration_seconds: delta(
            movingDuration.status === "available" ? movingDuration.seconds : null,
            baselineMovingDuration.status === "available" ? baselineMovingDuration.seconds : null,
          ),
          average_power_watts: delta(
            current.cycling?.average_power_watts ?? null,
            baselineValues.cycling?.average_power_watts ?? null,
          ),
          normalized_power_watts: delta(
            current.cycling?.normalized_power_watts ?? null,
            baselineValues.cycling?.normalized_power_watts ?? null,
          ),
          average_heart_rate_bpm: delta(
            current.cycling?.average_heart_rate_bpm ?? null,
            baselineValues.cycling?.average_heart_rate_bpm ?? null,
          ),
          average_cadence_rpm: delta(
            current.cycling?.average_cadence_rpm ?? null,
            baselineValues.cycling?.average_cadence_rpm ?? null,
          ),
          power_to_heart_rate_ratio: delta(
            current.cycling?.power_to_heart_rate_ratio ?? null,
            baselineValues.cycling?.power_to_heart_rate_ratio ?? null,
          ),
          distance_meters: delta(
            current.cycling?.distance_meters ?? null,
            baselineValues.cycling?.distance_meters ?? null,
          ),
          elevation_gain_meters: delta(
            current.cycling?.elevation_gain_meters ?? null,
            baselineValues.cycling?.elevation_gain_meters ?? null,
          ),
          average_temperature_c: delta(
            current.averageTemperatureC,
            baselineValues.averageTemperatureC,
          ),
          climbing_attempts: delta(
            current.climbing?.attempts_status === "complete" &&
              baselineValues.climbing?.attempts_status === "complete"
              ? current.climbing.attempts
              : null,
            current.climbing?.attempts_status === "complete" &&
              baselineValues.climbing?.attempts_status === "complete"
              ? baselineValues.climbing.attempts
              : null,
          ),
          climbing_sends: delta(
            current.climbing?.outcomes_status === "complete" &&
              baselineValues.climbing?.outcomes_status === "complete"
              ? current.climbing.sends
              : null,
            current.climbing?.outcomes_status === "complete" &&
              baselineValues.climbing?.outcomes_status === "complete"
              ? baselineValues.climbing.sends
              : null,
          ),
          strength_volume_kg_reps: delta(
            current.strength?.volume_status === "complete" &&
              baselineValues.strength?.volume_status === "complete"
              ? current.strength.valid_volume_kg_reps
              : null,
            current.strength?.volume_status === "complete" &&
              baselineValues.strength?.volume_status === "complete"
              ? baselineValues.strength.valid_volume_kg_reps
              : null,
          ),
          strength_estimated_one_rep_max_kg: delta(
            current.strength?.estimated_one_rep_max_status === "complete" &&
              baselineValues.strength?.estimated_one_rep_max_status === "complete"
              ? current.strength.best_estimated_one_rep_max_kg
              : null,
            current.strength?.estimated_one_rep_max_status === "complete" &&
              baselineValues.strength?.estimated_one_rep_max_status === "complete"
              ? baselineValues.strength.best_estimated_one_rep_max_kg
              : null,
          ),
        },
        quality: { comparable: true, flags },
        provenance: {
          value_kind: "mixed" as const,
          activity_deduplication: "fitness.v_activity" as const,
          sensor_deduplication:
            "analytics.activity_summary_rows/activity_sensor_sample FINAL" as const,
          ...buildSampleSourceSummary(
            sensorsByActivity.get(row.activity_id)?.sample_source_providers ?? [],
            sensorsByActivity.get(row.activity_id)?.sample_device_ids ?? [],
          ),
        },
      };
    };
    const performances = pageRows.map(performance);
    const nextRow = hasMore ? pageRows.at(-1) : undefined;
    return {
      range: { start_date: input.startDate, end_date: input.endDate, timezone: this.#timezone },
      equivalence: { ...equivalence, key: outputKey(equivalence.key) },
      baseline: {
        activity_id: baseline.activity_id,
        selection: input.referenceActivityId
          ? ("requested_reference" as const)
          : ("earliest_match_in_range" as const),
      },
      definitions: {
        comparison:
          "Only performances sharing the returned explicit or strongly evidenced identity are included; similarity by sport, duration, or effort alone is not equivalence.",
        moving_duration:
          "Moving duration is provider-reported raw evidence. Conflicting source values remain null and are not reconciled silently.",
        normalized_power:
          "Fourth root of the mean fourth power of complete 30-second rolling average power from deduplicated samples.",
        power_to_heart_rate_ratio:
          "Average power watts divided by average heart-rate bpm; null when either input is unavailable or heart rate is non-positive.",
        deltas:
          "Every numeric delta is candidate minus baseline; null means one or both values are missing.",
        strength_estimated_one_rep_max:
          "Epley: weight_kg × (1 + reps / 30), only for unflagged working sets with 1–12 repetitions.",
        causality:
          "These are descriptive within-equivalence comparisons and do not establish that training or recovery caused a change.",
      },
      coverage: {
        canonical_activities: pageRows.length,
        cycling_metrics_from_deduped_samples: pageRows.filter((row) =>
          hasObservedCyclingSensorData(row.canonical_type, sensorsByActivity.get(row.activity_id)),
        ).length,
        environment_metrics_from_deduped_samples: pageRows.filter(
          (row) => sensorsByActivity.get(row.activity_id)?.average_temperature_c != null,
        ).length,
        activities_with_missing_duration: pageRows.filter((row) => durationSeconds(row) === null)
          .length,
        timezone_assumed_activities: pageRows.filter((row) => !row.date_was_authoritative).length,
        performances_with_equivalence_evidence: pageRows.filter(
          (row) =>
            buildEquivalenceEvidence(equivalence.key, {
              activityId: row.activity_id,
              activityName: row.activity_name,
              sourceRawEvidence: row.source_raw_evidence,
              climbingRows: climbsByActivity.get(row.activity_id) ?? [],
              strengthRows: strengthByActivity.get(row.activity_id) ?? [],
            }).count > 0,
        ).length,
        performances_with_moving_duration: pageRows.filter(
          (row) => buildMovingDuration(row.source_raw_evidence).status === "available",
        ).length,
      },
      performances,
      rejected_near_matches: {
        status: "not_evaluated" as const,
        reason:
          "Fuzzy near matches are intentionally not searched because similarity does not establish performance equivalence.",
        items: [],
      },
      pagination: {
        limit: input.limit,
        has_more: hasMore,
        next_cursor: nextRow ? encodeCursor(this.#userId, shape, nextRow) : null,
      },
    };
  }
}
