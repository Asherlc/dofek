import { createHash } from "node:crypto";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import {
  fingerLoadingExerciseSchema,
  fingerLoadingGripPositionSchema,
  fingerLoadingLateralitySchema,
} from "./climbing-training-log-repository.ts";

const sourceExternalIdSchema = z.object({
  providerId: z.string(),
  externalId: z.string(),
  memberActivityId: z.string().optional(),
  subsource: z.string().nullable().optional(),
});

const rowSchema = z.object({
  activity_id: z.string().uuid(),
  activity_name: z.string().nullable(),
  activity_started_at: timestampStringSchema,
  activity_ended_at: timestampStringSchema.nullable(),
  session_date: dateStringSchema,
  source_providers: z.array(z.string()),
  source_external_ids: z.array(sourceExternalIdSchema).nullable().default(null),
  member_activity_ids: z.array(z.string().uuid()),
  timezone: z.string().nullable(),
  start_utc_offset_minutes: z.coerce.number().int().nullable(),
  end_utc_offset_minutes: z.coerce.number().int().nullable(),
  local_time_source: z.string(),
  entry_id: z.string().uuid(),
  entry_activity_id: z.string().uuid(),
  entry_provider: z.string(),
  exercise: fingerLoadingExerciseSchema,
  edge_size_mm: z.coerce.number().positive().nullable(),
  grip_position: fingerLoadingGripPositionSchema.nullable(),
  external_load_kg: z.coerce.number(),
  bodyweight_kg: z.coerce.number().positive(),
  laterality: fingerLoadingLateralitySchema,
  set_count: z.coerce.number().int().positive(),
  hold_duration_seconds: z.coerce.number().positive(),
  rest_interval_seconds: z.coerce.number().int().nonnegative(),
  rpe: z.coerce.number().min(0).max(10).nullable(),
  notes: z.string().nullable(),
});
const coverageRowSchema = z.object({ first_observed_date: dateStringSchema.nullable() });
const precedingStreakRowSchema = z.object({
  preceding_consecutive_days: z.coerce.number().int().nonnegative(),
});
const climbingDateRowSchema = z.object({ climbing_exposure_date: dateStringSchema });
const climbingCoverageRowSchema = z.object({
  first_observed_climbing_date: dateStringSchema.nullable(),
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

type Row = z.infer<typeof rowSchema>;
type Exercise = z.infer<typeof fingerLoadingExerciseSchema>;

export interface FingerLoadingThresholds {
  minEffectiveLoadKg: number | null;
  minLoadToBodyweightRatio: number | null;
  minRpe: number | null;
}

export interface FingerLoadingProgressionInput {
  startDate: string;
  endDate: string;
  providers: string[];
  exercises: Exercise[];
  thresholds: FingerLoadingThresholds;
  cursor: string | null;
  limit: number;
}

interface ConsolidatedEntry {
  row: Row;
  sourceEntryIds: string[];
  sourceActivityIds: string[];
  sourceProviders: string[];
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function datesBetween(startDate: string, endDate: string): string[] {
  const result: string[] = [];
  for (let date = startDate; date <= endDate; date = shiftDate(date, 1)) result.push(date);
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function observationFingerprint(row: Row): string {
  return JSON.stringify([
    row.exercise,
    row.edge_size_mm,
    row.grip_position,
    row.external_load_kg,
    row.bodyweight_kg,
    row.laterality,
    row.set_count,
    row.hold_duration_seconds,
    row.rest_interval_seconds,
    row.rpe,
    row.notes,
  ]);
}

function identityFingerprint(row: Row): string {
  return JSON.stringify([
    row.activity_id,
    row.exercise,
    row.edge_size_mm,
    row.grip_position,
    row.laterality,
  ]);
}

function consolidateExactDuplicates(rows: Row[]): {
  entries: ConsolidatedEntry[];
  mergedRecords: number;
  possibleDuplicateEntryIds: Set<string>;
  possibleDuplicateGroups: string[][];
} {
  const entries: ConsolidatedEntry[] = [];
  const candidates = new Map<string, ConsolidatedEntry[]>();
  let mergedRecords = 0;
  for (const row of rows) {
    const fingerprint = observationFingerprint(row);
    const matching = candidates.get(fingerprint) ?? [];
    const duplicate = matching.find(
      (candidate) =>
        candidate.row.activity_id === row.activity_id &&
        candidate.row.entry_activity_id !== row.entry_activity_id &&
        !candidate.sourceProviders.includes(row.entry_provider),
    );
    if (duplicate) {
      duplicate.sourceEntryIds = unique([...duplicate.sourceEntryIds, row.entry_id]);
      duplicate.sourceActivityIds = unique([...duplicate.sourceActivityIds, row.entry_activity_id]);
      duplicate.sourceProviders = unique([...duplicate.sourceProviders, row.entry_provider]);
      mergedRecords += 1;
      continue;
    }
    const entry = {
      row,
      sourceEntryIds: [row.entry_id],
      sourceActivityIds: [row.entry_activity_id],
      sourceProviders: [row.entry_provider],
    };
    entries.push(entry);
    candidates.set(fingerprint, [...matching, entry]);
  }
  const byIdentity = new Map<string, ConsolidatedEntry[]>();
  for (const entry of entries) {
    const identity = identityFingerprint(entry.row);
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), entry]);
  }
  const possibleDuplicateGroups = [...byIdentity.values()]
    .filter(
      (matching) =>
        matching.length > 1 &&
        unique(matching.flatMap((entry) => entry.sourceActivityIds)).length > 1 &&
        unique(matching.flatMap((entry) => entry.sourceProviders)).length > 1,
    )
    .map((matching) => unique(matching.flatMap((entry) => entry.sourceEntryIds)));
  return {
    entries,
    mergedRecords,
    possibleDuplicateEntryIds: new Set(possibleDuplicateGroups.flat()),
    possibleDuplicateGroups,
  };
}

function effectiveLoadKg(row: Row): number {
  return row.bodyweight_kg + row.external_load_kg;
}

function loadRatio(row: Row): number {
  return effectiveLoadKg(row) / row.bodyweight_kg;
}

function hasThresholds(thresholds: FingerLoadingThresholds): boolean {
  return Object.values(thresholds).some((value) => value !== null);
}

function isHighIntensity(row: Row, thresholds: FingerLoadingThresholds): boolean | null {
  if (!hasThresholds(thresholds)) return null;
  return (
    (thresholds.minEffectiveLoadKg !== null &&
      effectiveLoadKg(row) >= thresholds.minEffectiveLoadKg) ||
    (thresholds.minLoadToBodyweightRatio !== null &&
      loadRatio(row) >= thresholds.minLoadToBodyweightRatio) ||
    (thresholds.minRpe !== null && row.rpe !== null && row.rpe >= thresholds.minRpe)
  );
}

function cursorShape(input: FingerLoadingProgressionInput, timezone: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        startDate: input.startDate,
        endDate: input.endDate,
        providers: [...input.providers].sort(),
        exercises: [...input.exercises].sort(),
        thresholds: input.thresholds,
        timezone,
      }),
    )
    .digest("base64url");
}

function decodeCursor(cursor: string | null, userId: string, shape: string) {
  if (cursor === null) return null;
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (parsed.userId !== userId || parsed.shape !== shape) throw new Error("cursor mismatch");
    return parsed;
  } catch {
    throw new Error("Invalid finger-loading progression cursor");
  }
}

function encodeCursor(row: Row, userId: string, shape: string): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      userId,
      shape,
      startedAt: row.activity_started_at,
      activityId: row.activity_id,
    }),
    "utf8",
  ).toString("base64url");
}

function maxOrNull(values: number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

/** Exact-range finger-loading analytics over canonical activity groups. */
export class FingerLoadingProgressionRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  #localDateSql() {
    return sql`CASE
      WHEN a.local_time_source IN (
        'provider_timezone', 'device_timezone', 'user_home_timezone',
        'gps_timezone', 'home_zone_fallback'
      ) AND a.timezone IS NOT NULL
        THEN (a.started_at AT TIME ZONE a.timezone)::date
      WHEN a.local_time_source IN ('provider_offset', 'device_offset')
        AND a.start_utc_offset_minutes IS NOT NULL
        THEN ((a.started_at AT TIME ZONE 'UTC')
          + a.start_utc_offset_minutes * INTERVAL '1 minute')::date
      ELSE (a.started_at AT TIME ZONE ${this.#timezone})::date
    END`;
  }

  async listRange(input: FingerLoadingProgressionInput) {
    const localDate = this.#localDateSql();
    const shape = cursorShape(input, this.#timezone);
    const cursor = decodeCursor(input.cursor, this.#userId, shape);
    const providerPredicate =
      input.providers.length === 0
        ? sql`true`
        : sql`(
            source_activity.provider_id IN (${sql.join(
              input.providers.map((provider) => sql`${provider}`),
              sql`, `,
            )})
            OR a.source_providers && ARRAY[${sql.join(
              input.providers.map((provider) => sql`${provider}`),
              sql`, `,
            )}]::text[]
          )`;
    const canonicalActivityProviderPredicate =
      input.providers.length === 0
        ? sql`true`
        : sql`a.source_providers && ARRAY[${sql.join(
            input.providers.map((provider) => sql`${provider}`),
            sql`, `,
          )}]::text[]`;
    const exercisePredicate =
      input.exercises.length === 0
        ? sql`true`
        : sql`entry.exercise::text IN (${sql.join(
            input.exercises.map((exercise) => sql`${exercise}`),
            sql`, `,
          )})`;

    const rows = await executeWithSchema(
      this.#db,
      rowSchema,
      sql`SELECT
            a.id::text AS activity_id,
            a.name AS activity_name,
            a.started_at::text AS activity_started_at,
            a.ended_at::text AS activity_ended_at,
            (${localDate})::text AS session_date,
            a.source_providers,
            a.source_external_ids,
            a.member_activity_ids,
            a.timezone,
            a.start_utc_offset_minutes,
            a.end_utc_offset_minutes,
            a.local_time_source,
            entry.id::text AS entry_id,
            entry.activity_id::text AS entry_activity_id,
            source_activity.provider_id AS entry_provider,
            entry.exercise,
            entry.edge_size_mm,
            entry.grip_position,
            entry.external_load_kg,
            entry.bodyweight_kg,
            entry.laterality,
            entry.set_count,
            entry.hold_duration_seconds,
            entry.rest_interval_seconds,
            entry.rpe,
            entry.notes
          FROM fitness.v_activity AS a
          JOIN fitness.finger_loading_entry AS entry
            ON entry.activity_id = ANY(a.member_activity_ids)
          JOIN fitness.activity AS source_activity ON source_activity.id = entry.activity_id
          WHERE a.user_id = ${this.#userId}::uuid
            AND ${localDate} BETWEEN ${input.startDate}::date AND ${input.endDate}::date
            AND ${providerPredicate}
            AND ${exercisePredicate}
          ORDER BY a.started_at DESC, a.id, entry.created_at DESC, entry.id`,
    );
    const { entries, mergedRecords, possibleDuplicateEntryIds, possibleDuplicateGroups } =
      consolidateExactDuplicates(rows);
    const aggregateEntries = entries.filter(
      (entry) => !entry.sourceEntryIds.some((entryId) => possibleDuplicateEntryIds.has(entryId)),
    );

    const [coverage] = await executeWithSchema(
      this.#db,
      coverageRowSchema,
      sql`SELECT MIN(${localDate})::text AS first_observed_date
          FROM fitness.v_activity AS a
          JOIN fitness.finger_loading_entry AS entry
            ON entry.activity_id = ANY(a.member_activity_ids)
          JOIN fitness.activity AS source_activity ON source_activity.id = entry.activity_id
          WHERE a.user_id = ${this.#userId}::uuid
            AND ${providerPredicate}
            AND ${exercisePredicate}`,
    );
    const [precedingStreak] = await executeWithSchema(
      this.#db,
      precedingStreakRowSchema,
      sql`WITH exposure_dates AS (
            SELECT DISTINCT ${localDate} AS date
            FROM fitness.v_activity AS a
            JOIN fitness.finger_loading_entry AS entry
              ON entry.activity_id = ANY(a.member_activity_ids)
            JOIN fitness.activity AS source_activity ON source_activity.id = entry.activity_id
            WHERE a.user_id = ${this.#userId}::uuid
              AND ${localDate} < ${input.startDate}::date
              AND ${providerPredicate}
              AND ${exercisePredicate}
          ), numbered AS (
            SELECT date, ROW_NUMBER() OVER (ORDER BY date DESC) AS position
            FROM exposure_dates
          )
          SELECT COUNT(*)::int AS preceding_consecutive_days
          FROM numbered
          WHERE date = ${input.startDate}::date - position::int`,
    );
    const climbingDates = await executeWithSchema(
      this.#db,
      climbingDateRowSchema,
      sql`SELECT DISTINCT (${localDate})::text AS climbing_exposure_date
          FROM fitness.v_activity AS a
          WHERE a.user_id = ${this.#userId}::uuid
            AND a.canonical_type = 'climbing'
            AND ${localDate} BETWEEN ${input.startDate}::date AND ${input.endDate}::date
            AND ${canonicalActivityProviderPredicate}
          ORDER BY climbing_exposure_date`,
    );
    const [climbingCoverage] = await executeWithSchema(
      this.#db,
      climbingCoverageRowSchema,
      sql`SELECT MIN(${localDate})::text AS first_observed_climbing_date
          FROM fitness.v_activity AS a
          WHERE a.user_id = ${this.#userId}::uuid
            AND a.canonical_type = 'climbing'
            AND ${canonicalActivityProviderPredicate}`,
    );
    const fingerFirstObservedDate = coverage?.first_observed_date ?? null;
    const climbingFirstObservedDate = climbingCoverage?.first_observed_climbing_date ?? null;
    const firstJointCoverageDate =
      fingerFirstObservedDate === null || climbingFirstObservedDate === null
        ? null
        : fingerFirstObservedDate > climbingFirstObservedDate
          ? fingerFirstObservedDate
          : climbingFirstObservedDate;
    const combinedPrecedingStreak =
      firstJointCoverageDate === null || input.startDate <= firstJointCoverageDate
        ? null
        : ((
            await executeWithSchema(
              this.#db,
              precedingStreakRowSchema,
              sql`WITH finger_dates AS (
            SELECT DISTINCT ${localDate} AS date
            FROM fitness.v_activity AS a
            JOIN fitness.finger_loading_entry AS entry
              ON entry.activity_id = ANY(a.member_activity_ids)
            JOIN fitness.activity AS source_activity ON source_activity.id = entry.activity_id
            WHERE a.user_id = ${this.#userId}::uuid
              AND ${localDate} < ${input.startDate}::date
              AND ${localDate} >= ${firstJointCoverageDate}::date
              AND ${providerPredicate}
              AND ${exercisePredicate}
          ), climbing_dates AS (
            SELECT DISTINCT ${localDate} AS date
            FROM fitness.v_activity AS a
            WHERE a.user_id = ${this.#userId}::uuid
              AND a.canonical_type = 'climbing'
              AND ${localDate} < ${input.startDate}::date
              AND ${localDate} >= ${firstJointCoverageDate}::date
              AND ${canonicalActivityProviderPredicate}
          ), exposure_dates AS (
            SELECT date FROM finger_dates
            UNION
            SELECT date FROM climbing_dates
          ), numbered AS (
            SELECT date, ROW_NUMBER() OVER (ORDER BY date DESC) AS position
            FROM exposure_dates
          )
          SELECT COUNT(*)::int AS preceding_consecutive_days
          FROM numbered
          WHERE date = ${input.startDate}::date - position::int`,
            )
          )[0] ?? null);

    const byActivity = new Map<string, Row[]>();
    const entriesByActivity = new Map<string, ConsolidatedEntry[]>();
    for (const row of rows) {
      byActivity.set(row.activity_id, [...(byActivity.get(row.activity_id) ?? []), row]);
    }
    for (const entry of entries) {
      entriesByActivity.set(entry.row.activity_id, [
        ...(entriesByActivity.get(entry.row.activity_id) ?? []),
        entry,
      ]);
    }
    const sessionRows = [...byActivity.values()]
      .map((matching) => matching[0])
      .filter((row): row is Row => row !== undefined)
      .sort(
        (left, right) =>
          right.activity_started_at.localeCompare(left.activity_started_at) ||
          right.activity_id.localeCompare(left.activity_id),
      );
    const pageCandidates = cursor
      ? sessionRows.filter(
          (row) =>
            row.activity_started_at < cursor.startedAt ||
            (row.activity_started_at === cursor.startedAt && row.activity_id < cursor.activityId),
        )
      : sessionRows;
    const page = pageCandidates.slice(0, input.limit);
    const hasMore = pageCandidates.length > input.limit;

    const entryOutput = (entry: ConsolidatedEntry) => {
      const row = entry.row;
      const excludedFromAggregates = entry.sourceEntryIds.some((entryId) =>
        possibleDuplicateEntryIds.has(entryId),
      );
      return {
        id: row.entry_id,
        protocol: row.exercise,
        grip_type: row.grip_position,
        edge_size_mm: row.edge_size_mm,
        original_external_load_kg: row.external_load_kg,
        added_weight_kg: Math.max(0, row.external_load_kg),
        assistance_kg: Math.max(0, -row.external_load_kg),
        bodyweight_kg: row.bodyweight_kg,
        effective_load_kg: effectiveLoadKg(row),
        load_to_bodyweight_ratio: loadRatio(row),
        hang_duration_seconds: row.hold_duration_seconds,
        rest_duration_seconds: row.rest_interval_seconds,
        pain: null,
        pain_status: "not_recorded_by_canonical_schema" as const,
        repetitions_per_set: null,
        repetitions_status: "not_recorded_by_canonical_schema" as const,
        sets: row.set_count,
        laterality: row.laterality,
        rpe: row.rpe,
        notes: row.notes,
        total_time_under_tension_seconds: null,
        effective_load_kg_seconds: null,
        exposure_calculation: {
          status: "unavailable" as const,
          reason:
            "Exact exposure requires repetitions per set, which the canonical source schema does not record.",
        },
        high_intensity: isHighIntensity(row, input.thresholds),
        excluded_from_aggregates: excludedFromAggregates,
        quality_flags: excludedFromAggregates ? ["possible_overlapping_provider_observation"] : [],
        provenance: {
          value_kind: "mixed" as const,
          source_recorded_fields: [
            "protocol",
            "grip_type",
            "edge_size_mm",
            "original_external_load_kg",
            "bodyweight_kg",
            "hang_duration_seconds",
            "rest_duration_seconds",
            "sets",
            "laterality",
            "rpe",
            "notes",
          ],
          calculated_fields: [
            "added_weight_kg",
            "assistance_kg",
            "effective_load_kg",
            "load_to_bodyweight_ratio",
            "high_intensity",
          ],
          source_entry_ids: entry.sourceEntryIds,
          source_activity_ids: entry.sourceActivityIds,
          source_providers: entry.sourceProviders,
          merged_duplicate: entry.sourceEntryIds.length > 1,
        },
      };
    };

    const sessions = page.map((row) => ({
      activity_id: row.activity_id,
      date: row.session_date,
      started_at: row.activity_started_at,
      duration_minutes:
        row.activity_ended_at === null
          ? null
          : (new Date(row.activity_ended_at).getTime() -
              new Date(row.activity_started_at).getTime()) /
            60_000,
      name: row.activity_name,
      source_providers: row.source_providers,
      source_external_ids: row.source_external_ids ?? [],
      member_activity_ids: row.member_activity_ids,
      timezone: {
        value: row.timezone,
        start_utc_offset_minutes: row.start_utc_offset_minutes,
        end_utc_offset_minutes: row.end_utc_offset_minutes,
        local_time_source: row.local_time_source,
        analysis_timezone: this.#timezone,
        assumed: row.local_time_source === "unknown",
      },
      quality_flags: [
        ...(row.local_time_source === "unknown" ? ["timezone_assumed_from_user_context"] : []),
        ...((entriesByActivity.get(row.activity_id) ?? []).some((entry) =>
          entry.sourceEntryIds.some((entryId) => possibleDuplicateEntryIds.has(entryId)),
        )
          ? ["possible_overlapping_finger_loading_entries"]
          : []),
      ],
      entries: (entriesByActivity.get(row.activity_id) ?? []).map(entryOutput),
    }));

    const dailyEntries = new Map<string, ConsolidatedEntry[]>();
    const dailyAggregateEntries = new Map<string, ConsolidatedEntry[]>();
    const dailySessions = new Map<string, number>();
    for (const row of sessionRows) {
      dailySessions.set(row.session_date, (dailySessions.get(row.session_date) ?? 0) + 1);
    }
    for (const entry of entries) {
      dailyEntries.set(entry.row.session_date, [
        ...(dailyEntries.get(entry.row.session_date) ?? []),
        entry,
      ]);
    }
    for (const entry of aggregateEntries) {
      dailyAggregateEntries.set(entry.row.session_date, [
        ...(dailyAggregateEntries.get(entry.row.session_date) ?? []),
        entry,
      ]);
    }
    const firstObservedDate = coverage?.first_observed_date ?? null;
    let consecutiveDays = precedingStreak?.preceding_consecutive_days ?? 0;
    const thresholdAvailable = hasThresholds(input.thresholds);
    const daily = datesBetween(input.startDate, input.endDate).map((date) => {
      if (firstObservedDate === null || date < firstObservedDate) {
        consecutiveDays = 0;
        return {
          date,
          exposure_status: "unavailable" as const,
          sessions: null,
          entries: null,
          entries_in_aggregates: null,
          total_time_under_tension_seconds: null,
          effective_load_kg_seconds: null,
          max_effective_load_kg: null,
          max_load_to_bodyweight_ratio: null,
          high_intensity_entries: null,
          high_intensity_day: null,
          is_rest_day: null,
          consecutive_finger_loading_days: null,
        };
      }
      const matching = dailyEntries.get(date) ?? [];
      const matchingAggregates = dailyAggregateEntries.get(date) ?? [];
      const sessionCount = dailySessions.get(date) ?? 0;
      if (sessionCount === 0) consecutiveDays = 0;
      else consecutiveDays += 1;
      const matchingHigh = matchingAggregates.filter(
        (entry) => isHighIntensity(entry.row, input.thresholds) === true,
      ).length;
      return {
        date,
        exposure_status: sessionCount === 0 ? ("not_observed" as const) : ("observed" as const),
        sessions: sessionCount,
        entries: matching.length,
        entries_in_aggregates: matchingAggregates.length,
        total_time_under_tension_seconds: null,
        effective_load_kg_seconds: null,
        max_effective_load_kg: maxOrNull(
          matchingAggregates.map((entry) => effectiveLoadKg(entry.row)),
        ),
        max_load_to_bodyweight_ratio: maxOrNull(
          matchingAggregates.map((entry) => loadRatio(entry.row)),
        ),
        high_intensity_entries: thresholdAvailable ? matchingHigh : null,
        high_intensity_day: thresholdAvailable ? matchingHigh > 0 : null,
        is_rest_day: sessionCount === 0,
        consecutive_finger_loading_days: consecutiveDays,
      };
    });

    const matchingHighEntries = aggregateEntries.filter(
      (entry) => isHighIntensity(entry.row, input.thresholds) === true,
    );
    const fingerExposureDates = new Set(sessionRows.map((row) => row.session_date));
    const climbingExposureDates = new Set(climbingDates.map((row) => row.climbing_exposure_date));
    let combinedConsecutiveDays = combinedPrecedingStreak?.preceding_consecutive_days ?? 0;
    const combinedExposureDaily = datesBetween(input.startDate, input.endDate).map((date) => {
      const fingerLoadingStatus =
        fingerFirstObservedDate === null || date < fingerFirstObservedDate
          ? ("unavailable" as const)
          : fingerExposureDates.has(date)
            ? ("observed" as const)
            : ("not_observed" as const);
      const climbingStatus =
        climbingFirstObservedDate === null || date < climbingFirstObservedDate
          ? ("unavailable" as const)
          : climbingExposureDates.has(date)
            ? ("observed" as const)
            : ("not_observed" as const);
      const fingerLoading =
        fingerLoadingStatus === "unavailable" ? null : fingerLoadingStatus === "observed";
      const climbing = climbingStatus === "unavailable" ? null : climbingStatus === "observed";
      const exposureStatus =
        fingerLoading === true || climbing === true
          ? ("observed" as const)
          : fingerLoading === false && climbing === false
            ? ("not_observed" as const)
            : ("unavailable" as const);
      const anyExposure = exposureStatus === "unavailable" ? null : exposureStatus === "observed";
      let consecutiveExposureDays: number | null = null;
      if (firstJointCoverageDate !== null && date >= firstJointCoverageDate) {
        if (anyExposure) combinedConsecutiveDays += 1;
        else combinedConsecutiveDays = 0;
        consecutiveExposureDays = combinedConsecutiveDays;
      }
      return {
        date,
        finger_loading: fingerLoading,
        finger_loading_status: fingerLoadingStatus,
        climbing,
        climbing_status: climbingStatus,
        any_exposure: anyExposure,
        exposure_status: exposureStatus,
        consecutive_exposure_days: consecutiveExposureDays,
      };
    });
    const lastPageRow = page.at(-1) ?? null;
    return {
      range: { start_date: input.startDate, end_date: input.endDate, timezone: this.#timezone },
      channel: {
        id: "finger_loading" as const,
        interchangeable_with: [],
        note: "Finger loading remains a separate exposure channel from climbing, cardiovascular, and generic strength load.",
      },
      definitions: {
        effective_load:
          "Bodyweight in kilograms plus the signed external load; negative external load is assistance.",
        time_under_tension:
          "Exact time under tension is unavailable because repetitions within a set are not recorded in the canonical source schema.",
        effective_load_kg_seconds:
          "Effective load multiplied by exact time under tension; it remains unavailable while repetitions per set are missing.",
        high_intensity:
          "An entry is high intensity when it meets any configured threshold. No classification is made without a caller-supplied threshold.",
        duplicate_handling:
          "Canonical activities count once; exact matching entries from different provider members are consolidated with all source evidence retained.",
        consecutive_days:
          "Count of consecutive local calendar days with at least one recorded finger-loading entry; no injury-risk interpretation is applied.",
      },
      coverage: {
        sessions: sessionRows.length,
        entries: entries.length,
        first_observed_date: firstObservedDate,
        timezone_assumed_sessions: sessionRows.filter((row) => row.local_time_source === "unknown")
          .length,
        merged_exact_duplicate_records: mergedRecords,
        possible_duplicate_groups: possibleDuplicateGroups.length,
        entries_excluded_from_aggregates: entries.length - aggregateEntries.length,
      },
      summary: {
        sessions: sessionRows.length,
        entries: aggregateEntries.length,
        total_time_under_tension_seconds: null,
        effective_load_kg_seconds: null,
        exposure_calculation: {
          status: "unavailable" as const,
          reason:
            "Exact exposure requires repetitions per set, which the canonical source schema does not record.",
        },
        max_effective_load_kg: maxOrNull(
          aggregateEntries.map((entry) => effectiveLoadKg(entry.row)),
        ),
        max_load_to_bodyweight_ratio: maxOrNull(
          aggregateEntries.map((entry) => loadRatio(entry.row)),
        ),
      },
      high_intensity: {
        status: thresholdAvailable ? ("available" as const) : ("unavailable" as const),
        thresholds: {
          min_effective_load_kg: input.thresholds.minEffectiveLoadKg,
          min_load_to_bodyweight_ratio: input.thresholds.minLoadToBodyweightRatio,
          min_rpe: input.thresholds.minRpe,
        },
        matching_entries: thresholdAvailable ? matchingHighEntries.length : null,
        days: thresholdAvailable
          ? new Set(matchingHighEntries.map((entry) => entry.row.session_date)).size
          : null,
        reason: thresholdAvailable
          ? null
          : "High-intensity classification requires at least one caller-supplied threshold.",
      },
      daily,
      combined_climbing_finger_exposure: {
        definition:
          "Calendar-day union of recorded climbing sessions and finger-loading sessions; it does not combine numeric load across modalities or imply injury risk. Absence and streaks are reported only from the first date when both channels have coverage.",
        first_joint_coverage_date: firstJointCoverageDate,
        daily: combinedExposureDaily,
      },
      sessions,
      pagination: {
        limit: input.limit,
        has_more: hasMore,
        next_cursor: hasMore && lastPageRow ? encodeCursor(lastPageRow, this.#userId, shape) : null,
      },
    };
  }
}
