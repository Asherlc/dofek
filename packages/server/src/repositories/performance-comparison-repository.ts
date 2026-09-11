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
  buildMovingDuration,
  cyclingEffortRequest,
  PERFORMANCE_COMPARISON_SENSOR_QUERY,
} from "./performance-comparison-context.ts";
import {
  indexComparisonIdentities,
  resolveComparisonEquivalence,
} from "./performance-comparison-equivalence.ts";
import {
  describeComparisonEvidence,
  PerformanceComparisonIdentity,
} from "./performance-comparison-identity.ts";
import {
  buildPerformanceComparisonRows,
  performanceClimbingRowSchema,
  performanceDurationSeconds,
  performanceSensorRowSchema,
  performanceStrengthRowSchema,
} from "./performance-comparison-result.ts";
import {
  isIdentityEquivalence,
  type PerformanceEquivalence,
} from "./performance-comparison-types.ts";

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
  discoveryActivityIds?: string[];
  startDate: string;
  endDate: string;
  referenceActivityId: string | null;
  equivalence: PerformanceEquivalence | null;
  providers: string[];
  modalities: string[];
  cursor: string | null;
  limit: number;
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function equivalencePredicate(key: PerformanceEquivalence): SQL {
  if (isIdentityEquivalence(key))
    throw new Error("Identity-model keys require authorized member selection");
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
  const discoveryMembers =
    input.discoveryActivityIds === undefined
      ? sql`true`
      : input.discoveryActivityIds.length
        ? sql`a.id IN (${sql.join(
            input.discoveryActivityIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql`false`;
  return sql`${providers} AND ${modalities} AND ${discoveryMembers} AND (a.ended_at IS NULL OR a.ended_at > a.started_at)`;
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
  if (isIdentityEquivalence(key)) return key;
  if (key.kind === "activity_name") {
    return {
      kind: key.kind,
      canonical_type: key.canonicalType,
      value: key.value,
      ...(key.asserted === undefined ? {} : { asserted: key.asserted }),
      ...(key.weakSpecification ? { weak_specification: key.weakSpecification } : {}),
    };
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
        discoveryActivityIds: input.discoveryActivityIds,
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
    const requested = unique(activityIds);
    if (requested.length === 0) return [];
    const rows = await executeWithSchema(
      this.#db,
      activityRowSchema,
      activitySelect(
        this.#userId,
        this.#timezone,
        sql`a.id IN (${sql.join(
          requested.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
        "performance-comparison:cycling-efforts",
        sql`ORDER BY a.started_at, a.id LIMIT ${requested.length}`,
      ),
    );
    const activitiesById = new Map(rows.map((activity) => [activity.activity_id, activity]));
    if (requested.some((id) => !activitiesById.has(id))) {
      throw new Error("A requested cycling activity was not found for this user");
    }
    const activities = requested.flatMap((id) => {
      const activity = activitiesById.get(id);
      return activity ? [activity] : [];
    });
    if (activities.some((activity) => activity.canonical_type !== "cycling")) {
      throw new Error("Cycling effort metrics require canonical cycling activities");
    }
    const completeActivities = activities.filter(
      (activity) => performanceDurationSeconds(activity) !== null,
    );
    return loadCyclingEffortMetrics(
      this.#db,
      this.#store,
      this.#userId,
      this.#timezone,
      completeActivities.map(cyclingEffortRequest),
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
    const identityRepository = new PerformanceComparisonIdentity(
      this.#db,
      this.#store,
      this.#userId,
    );
    const equivalence = await resolveComparisonEquivalence({
      requested: input.equivalence,
      reference,
      identities: identityRepository,
    });
    const localDate = postgresActivityLocalDate(sql`a`, this.#timezone);
    const range = sql`${localDate} BETWEEN ${input.startDate}::date AND ${input.endDate}::date`;
    const filters = filterPredicate(input);
    const modelKey = isIdentityEquivalence(equivalence.key) ? equivalence.key : null;
    const weakSpecification =
      equivalence.key.kind === "activity_name" ? equivalence.key.weakSpecification : undefined;
    const scope =
      modelKey || weakSpecification
        ? await executeWithSchema(
            this.#db,
            activityRowSchema,
            activitySelect(
              this.#userId,
              this.#timezone,
              modelKey?.kind === "canonical_route" && input.discoveryActivityIds
                ? filters
                : sql`${range} AND ${filters}`,
              "performance-comparison:scope",
              sql`ORDER BY a.started_at, a.id LIMIT 2001`,
            ),
          )
        : [];
    if (scope.length > 2000)
      throw new Error("Too many activities; narrow the comparison date range or filters.");
    const scopedIdentities =
      weakSpecification ||
      (modelKey && !["canonical_route", "user_defined_benchmark"].includes(modelKey.kind))
        ? await identityRepository.identities(scope)
        : [];
    const scopedIdentitiesByActivity = indexComparisonIdentities(scopedIdentities);
    if (modelKey && !input.equivalence) {
      for (const activity of scope) {
        const rows = scopedIdentitiesByActivity.get(activity.activity_id) ?? [];
        // Check all evidence of each eligible candidate before discarding keys that do not match.
        if (identityRepository.matching(modelKey, rows).length) {
          identityRepository.strongest(rows);
          // A higher-ranked kind must not mask ambiguity in the comparison identity kind.
          identityRepository.strongest(rows.filter((row) => row.kind === modelKey.kind));
        }
      }
    }
    const identityRows = weakSpecification
      ? identityRepository.matchingWeak(weakSpecification, scopedIdentities, scope)
      : modelKey
        ? identityRepository.matching(modelKey, scopedIdentities)
        : [];
    const matchingIdentitiesByActivity = indexComparisonIdentities(identityRows);
    const routeMatches =
      modelKey?.kind === "canonical_route"
        ? await identityRepository.routeMatches(
            modelKey.value,
            await identityRepository.routes(scope),
            scope,
          )
        : [];
    const benchmarkRows =
      modelKey?.kind === "user_defined_benchmark"
        ? await identityRepository.benchmark(modelKey.value)
        : [];
    if (benchmarkRows.length > 2000)
      throw new Error("Too many benchmark members; choose a smaller benchmark.");
    const matchedIds = unique([
      ...identityRows.map((row) => row.canonical_activity_id),
      ...routeMatches.map((row) => row.activityId),
      ...benchmarkRows.map((row) => row.canonical_activity_id),
    ]);
    const identity =
      modelKey || weakSpecification
        ? matchedIds.length
          ? sql`a.id IN (${sql.join(
              matchedIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql`false`
        : equivalencePredicate(equivalence.key);
    const evidenceFor = (activityId?: string) =>
      describeComparisonEvidence(equivalence, identityRows, this.#userId, activityId);
    const {
      identity: { kind: identityKind, value: identityValue },
    } = evidenceFor();
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
      performanceClimbingRowSchema,
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
            equivalence.key.kind === "climb" && !isIdentityEquivalence(equivalence.key)
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
      performanceStrengthRowSchema,
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
    const nonCyclingIds = [...pageRows, baseline]
      .filter((row) => row.canonical_type !== "cycling")
      .map((row) => row.activity_id);
    const sensorRows = nonCyclingIds.length
      ? await this.#store.query(performanceSensorRowSchema, PERFORMANCE_COMPARISON_SENSOR_QUERY, {
          userId: this.#userId,
          activityIds: unique(nonCyclingIds),
        })
      : [];

    const metricActivities = [
      ...new Map([...pageRows, baseline].map((row) => [row.activity_id, row])).values(),
    ];
    if (modelKey?.kind === "provider_route") {
      const routes = await identityRepository.routes(metricActivities);
      if (routes.some((route) => route.canonical_activity_id === baseline.activity_id)) {
        routeMatches.push(
          ...(await identityRepository.routeEvidence(
            baseline.activity_id,
            routes,
            metricActivities,
          )),
        );
      }
    }
    const cyclingActivities = metricActivities.filter(
      (row) => row.canonical_type === "cycling" && performanceDurationSeconds(row) !== null,
    );
    const effortRows: Awaited<ReturnType<typeof loadCyclingEffortMetrics>> = [];
    for (let index = 0; index < cyclingActivities.length; index += 25) {
      effortRows.push(
        ...(await loadCyclingEffortMetrics(
          this.#db,
          this.#store,
          this.#userId,
          this.#timezone,
          cyclingActivities.slice(index, index + 25).map(cyclingEffortRequest),
          [5, 60, 300, 1200],
        )),
      );
    }
    const { performances, observedCyclingActivityIds } = buildPerformanceComparisonRows({
      pageRows,
      baseline,
      equivalence,
      identityKind,
      identityValue,
      matchingIdentitiesByActivity,
      routeMatches,
      benchmarkRows,
      effortRows,
      sensorRows,
      climbingRows,
      strengthRows,
      timezone: this.#timezone,
      evidenceFor,
    });
    const nextRow = hasMore ? pageRows.at(-1) : undefined;
    return {
      range: { start_date: input.startDate, end_date: input.endDate, timezone: this.#timezone },
      equivalence: { ...evidenceFor(), key: outputKey(equivalence.key) },
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
          "Paired-sample power to heart-rate ratio from the shared cycling effort calculation; null when coverage is insufficient.",
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
          observedCyclingActivityIds.has(row.activity_id),
        ).length,
        environment_metrics_from_deduped_samples: performances.filter(
          (performance) => performance.metrics.environment.average_temperature_c != null,
        ).length,
        activities_with_missing_duration: pageRows.filter(
          (row) => performanceDurationSeconds(row) === null,
        ).length,
        timezone_assumed_activities: pageRows.filter((row) => !row.date_was_authoritative).length,
        performances_with_equivalence_evidence: performances.filter(
          (row) => row.equivalence_evidence_count > 0,
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
