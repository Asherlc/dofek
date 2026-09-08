import { computePowerTss } from "@dofek/training/pmc";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { SportSettingsRepository, type SportSettingsRow } from "./sport-settings-repository.ts";

const cyclingActivitySchema = z.object({
  activity_id: z.string().uuid().nullable(),
  date: z.string().nullable(),
  normalized_power: z.coerce.number().positive().nullable(),
  elapsed_seconds: z.coerce.number().nonnegative().nullable(),
  source_providers: z.array(z.string()),
  first_observed_date: z.string().nullable(),
});

const heartRateLoadSchema = z.object({
  date: z.string(),
  load_points: z.coerce.number().nonnegative(),
  covered_seconds: z.coerce.number().nonnegative(),
  activity_count: z.coerce.number().int().nonnegative(),
  activity_ids: z.array(z.string().uuid()),
  source_providers: z.array(z.string()),
  first_observed_date: z.string().nullable(),
});

const postgresLoadSchema = z.object({
  date: z.string(),
  session_rpe_source_providers: z.array(z.string()),
  climbing_source_providers: z.array(z.string()),
  finger_source_providers: z.array(z.string()),
  strength_source_providers: z.array(z.string()),
  session_rpe_load: z.coerce.number().nonnegative().nullable(),
  session_rpe_activities: z.coerce.number().int().nonnegative(),
  session_rpe_supported_activities: z.coerce.number().int().nonnegative(),
  session_rpe_activity_ids: z.array(z.string().uuid()),
  climbing_attempts: z.coerce.number().int().nonnegative().nullable(),
  climbing_entries: z.coerce.number().int().nonnegative(),
  climbing_entries_with_attempts: z.coerce.number().int().nonnegative(),
  climbing_session_minutes: z.coerce.number().nonnegative(),
  climbing_activity_ids: z.array(z.string().uuid()),
  finger_load_kg_seconds: z.coerce.number().nonnegative().nullable(),
  finger_entries: z.coerce.number().int().nonnegative(),
  finger_activity_ids: z.array(z.string().uuid()),
  strength_volume_kg_reps: z.coerce.number().nonnegative().nullable(),
  strength_working_sets: z.coerce.number().int().nonnegative(),
  strength_suspicious_sets: z.coerce.number().int().nonnegative(),
  strength_activity_ids: z.array(z.string().uuid()),
});

const postgresCoverageSchema = z.object({
  first_session_rpe_date: z.string().nullable(),
  first_climbing_date: z.string().nullable(),
  first_finger_date: z.string().nullable(),
  first_strength_date: z.string().nullable(),
});

type PostgresLoadRow = z.infer<typeof postgresLoadSchema>;

interface BaseChannel {
  dailyValue: number | null;
  status: "available" | "partial" | "unavailable" | "not_observed";
  reason: string | null;
  sourceActivityIds: string[];
  sourceProviders: string[];
  contributingRecords: number;
  supportedRecords: number;
  firstObservedDate: string | null;
  context: Record<string, number>;
}

interface ChannelDefinition {
  key:
    | "cycling_power_tss"
    | "heart_rate_zone_load"
    | "session_rpe"
    | "climbing_attempts"
    | "finger_load"
    | "strength_volume";
  unit: string;
}

const CHANNELS: ChannelDefinition[] = [
  { key: "cycling_power_tss", unit: "TSS points" },
  { key: "heart_rate_zone_load", unit: "weighted zone-minutes" },
  { key: "session_rpe", unit: "RPE-minutes" },
  { key: "climbing_attempts", unit: "attempts" },
  { key: "finger_load", unit: "kg-seconds" },
  { key: "strength_volume", unit: "kg-reps" },
];

function round(value: number, decimals = 3): number {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

function dateShift(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dateSeries(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = dateShift(date, 1)) dates.push(date);
  return dates;
}

function validZonePcts(value: unknown): number[] | null {
  const parsed = z.array(z.number().positive()).min(1).safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.every((pct, index) => index === 0 || pct > (parsed.data[index - 1] ?? 0))
    ? parsed.data
    : null;
}

function effectiveSetting(history: SportSettingsRow[], date: string): SportSettingsRow | null {
  return history.find((row) => row.effectiveFrom <= date) ?? null;
}

function emptyChannel(date: string, firstObservedDate: string | null): BaseChannel {
  if (firstObservedDate == null || date < firstObservedDate) {
    return {
      dailyValue: null,
      status: "unavailable",
      reason: "Source coverage had not begun by this date.",
      sourceActivityIds: [],
      sourceProviders: [],
      contributingRecords: 0,
      supportedRecords: 0,
      firstObservedDate,
      context: {},
    };
  }
  return {
    dailyValue: 0,
    status: "not_observed",
    reason: "No exposure was observed for this load channel on this date.",
    sourceActivityIds: [],
    sourceProviders: [],
    contributingRecords: 0,
    supportedRecords: 0,
    firstObservedDate,
    context: {},
  };
}

function unavailableChannel(
  reason: string,
  input: Omit<BaseChannel, "dailyValue" | "status" | "reason">,
): BaseChannel {
  return { ...input, dailyValue: null, status: "unavailable", reason };
}

function rollingFor(
  date: string,
  values: Map<string, BaseChannel>,
): {
  acute_7d_sum: number | null;
  chronic_28d_weekly_equivalent: number | null;
  workload_ratio: number | null;
  monotony_7d: number | null;
  strain_7d: number | null;
  acute_coverage_days: number;
  chronic_coverage_days: number;
  unavailable_reasons: string[];
} {
  const acuteValues = dateSeries(dateShift(date, -6), date).map(
    (candidate) => values.get(candidate)?.dailyValue ?? null,
  );
  const chronicValues = dateSeries(dateShift(date, -27), date).map(
    (candidate) => values.get(candidate)?.dailyValue ?? null,
  );
  const acutePresent = acuteValues.filter((value): value is number => value != null);
  const chronicPresent = chronicValues.filter((value): value is number => value != null);
  const acute =
    acutePresent.length === 7 ? acutePresent.reduce((total, value) => total + value, 0) : null;
  const chronic =
    chronicPresent.length === 28
      ? chronicPresent.reduce((total, value) => total + value, 0) / 4
      : null;
  const reasons: string[] = [];
  if (acute == null) reasons.push("Seven complete daily values are required for acute load.");
  if (chronic == null)
    reasons.push("Twenty-eight complete daily values are required for chronic load.");

  let monotony: number | null = null;
  let strain: number | null = null;
  if (acute != null) {
    const mean = acute / 7;
    const standardDeviation = Math.sqrt(
      acutePresent.reduce((total, value) => total + (value - mean) ** 2, 0) / 7,
    );
    if (standardDeviation > 0) {
      monotony = mean / standardDeviation;
      strain = acute * monotony;
    } else {
      reasons.push(
        "Monotony and strain are unavailable because the seven-day load variance is zero.",
      );
    }
  }
  return {
    acute_7d_sum: acute == null ? null : round(acute),
    chronic_28d_weekly_equivalent: chronic == null ? null : round(chronic),
    workload_ratio: acute != null && chronic != null && chronic > 0 ? round(acute / chronic) : null,
    monotony_7d: monotony == null ? null : round(monotony),
    strain_7d: strain == null ? null : round(strain),
    acute_coverage_days: acutePresent.length,
    chronic_coverage_days: chronicPresent.length,
    unavailable_reasons: reasons,
  };
}

function mergeUnique(...arrays: string[][]): string[] {
  return [...new Set(arrays.flat())].sort();
}

function baseAvailable(input: {
  value: number;
  activityIds: string[];
  providers: string[];
  records: number;
  firstObservedDate: string | null;
  context?: Record<string, number>;
}): BaseChannel {
  return {
    dailyValue: round(input.value),
    status: "available",
    reason: null,
    sourceActivityIds: input.activityIds,
    sourceProviders: input.providers,
    contributingRecords: input.records,
    supportedRecords: input.records,
    firstObservedDate: input.firstObservedDate,
    context: input.context ?? {},
  };
}

function postgresChannels(
  row: PostgresLoadRow | undefined,
  coverage: z.infer<typeof postgresCoverageSchema> | undefined,
) {
  if (!row) return null;
  const sessionRpe =
    row.session_rpe_load == null
      ? unavailableChannel("No activity has both duration and recorded session RPE.", {
          sourceProviders: row.session_rpe_source_providers,
          sourceActivityIds: row.session_rpe_activity_ids,
          contributingRecords: row.session_rpe_activities,
          supportedRecords: 0,
          firstObservedDate: coverage?.first_session_rpe_date ?? null,
          context: { activities: row.session_rpe_activities },
        })
      : {
          ...baseAvailable({
            value: row.session_rpe_load,
            activityIds: row.session_rpe_activity_ids,
            providers: row.session_rpe_source_providers,
            records: row.session_rpe_supported_activities,
            firstObservedDate: coverage?.first_session_rpe_date ?? null,
            context: {
              activities: row.session_rpe_activities,
              activities_with_rpe: row.session_rpe_supported_activities,
            },
          }),
          status:
            row.session_rpe_supported_activities === row.session_rpe_activities
              ? ("available" as const)
              : ("partial" as const),
          reason:
            row.session_rpe_supported_activities === row.session_rpe_activities
              ? null
              : `${row.session_rpe_activities - row.session_rpe_supported_activities} activities lacked session RPE.`,
          contributingRecords: row.session_rpe_activities,
        };
  const climbingFirstObserved = coverage?.first_climbing_date ?? null;
  const climbing =
    row.climbing_entries === 0
      ? emptyChannel(row.date, climbingFirstObserved)
      : row.climbing_entries_with_attempts === 0
        ? unavailableChannel(
            `Attempt information is missing for all ${row.climbing_entries} climbing entries.`,
            {
              sourceProviders: row.climbing_source_providers,
              sourceActivityIds: row.climbing_activity_ids,
              contributingRecords: row.climbing_entries,
              supportedRecords: 0,
              firstObservedDate: climbingFirstObserved,
              context: {
                entries: row.climbing_entries,
                entries_with_attempt_data: 0,
                session_minutes: row.climbing_session_minutes,
              },
            },
          )
        : {
            ...baseAvailable({
              value: row.climbing_attempts ?? 0,
              activityIds: row.climbing_activity_ids,
              providers: row.climbing_source_providers,
              records: row.climbing_entries_with_attempts,
              firstObservedDate: climbingFirstObserved,
              context: {
                entries: row.climbing_entries,
                entries_with_attempt_data: row.climbing_entries_with_attempts,
                session_minutes: row.climbing_session_minutes,
              },
            }),
            status:
              row.climbing_entries_with_attempts === row.climbing_entries
                ? ("available" as const)
                : ("partial" as const),
            reason:
              row.climbing_entries_with_attempts === row.climbing_entries
                ? null
                : `${row.climbing_entries - row.climbing_entries_with_attempts} climbing entries lacked attempt information.`,
            contributingRecords: row.climbing_entries,
          };
  const finger =
    row.finger_entries === 0
      ? emptyChannel(row.date, coverage?.first_finger_date ?? null)
      : row.finger_load_kg_seconds == null
        ? unavailableChannel(
            "Exact finger-load volume requires repetitions per set, which the canonical source schema does not record.",
            {
              sourceProviders: row.finger_source_providers,
              sourceActivityIds: row.finger_activity_ids,
              contributingRecords: row.finger_entries,
              supportedRecords: 0,
              firstObservedDate: coverage?.first_finger_date ?? null,
              context: { entries: row.finger_entries },
            },
          )
        : baseAvailable({
            value: row.finger_load_kg_seconds,
            activityIds: row.finger_activity_ids,
            providers: row.finger_source_providers,
            records: row.finger_entries,
            firstObservedDate: coverage?.first_finger_date ?? null,
            context: { entries: row.finger_entries },
          });
  const strength =
    row.strength_working_sets === 0 && row.strength_suspicious_sets === 0
      ? emptyChannel(row.date, coverage?.first_strength_date ?? null)
      : row.strength_working_sets === 0 && row.strength_suspicious_sets > 0
        ? unavailableChannel(
            `All ${row.strength_suspicious_sets} strength sets were excluded by validation rules.`,
            {
              sourceProviders: row.strength_source_providers,
              sourceActivityIds: row.strength_activity_ids,
              contributingRecords: row.strength_suspicious_sets,
              supportedRecords: 0,
              firstObservedDate: coverage?.first_strength_date ?? null,
              context: {
                working_sets: 0,
                suspicious_sets_excluded: row.strength_suspicious_sets,
              },
            },
          )
        : {
            ...baseAvailable({
              value: row.strength_volume_kg_reps ?? 0,
              activityIds: row.strength_activity_ids,
              providers: row.strength_source_providers,
              records: row.strength_working_sets,
              firstObservedDate: coverage?.first_strength_date ?? null,
              context: {
                working_sets: row.strength_working_sets,
                suspicious_sets_excluded: row.strength_suspicious_sets,
              },
            }),
            status:
              row.strength_suspicious_sets === 0 ? ("available" as const) : ("partial" as const),
            reason:
              row.strength_suspicious_sets === 0
                ? null
                : `${row.strength_suspicious_sets} strength sets were excluded by validation rules.`,
            contributingRecords: row.strength_working_sets + row.strength_suspicious_sets,
          };
  return { sessionRpe, climbing, finger, strength };
}

function definitions() {
  return {
    cycling_power_tss:
      "Elapsed hours × (normalized power ÷ effective FTP)² × 100. Missing FTP or normalized power is not zero.",
    heart_rate_zone_load:
      "Sum of covered minutes in each configured threshold-HR zone multiplied by its one-based zone number.",
    session_rpe: "Recorded session RPE multiplied by activity duration in minutes.",
    climbing_attempts:
      "Recorded attempt counts. Entries with unknown attempts are reported as missing, not failed or zero.",
    finger_load:
      "Effective-load kg-seconds require repetitions per set and remain unavailable while the canonical source schema does not record repetitions.",
    strength_volume:
      "Sum of weight × reps for non-warmup load-bearing sets with 1–100 reps and 0–500 kg.",
    rolling:
      "Acute is a 7-day sum; chronic is the 28-day sum divided by four; ratio is acute ÷ chronic only with complete windows. These descriptive values do not diagnose injury risk.",
    monotony_strain:
      "Monotony is seven-day mean ÷ population standard deviation; strain is seven-day sum × monotony. Zero variance is unavailable.",
  };
}

/** Date-aligned load vectors that preserve each modality's native unit. */
export class AnalyticalTrainingLoadRepository {
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

  async listRange(startDate: string, endDate: string) {
    const calculationStart = dateShift(startDate, -27);
    const settingsHistory = await new SportSettingsRepository(this.#db, this.#userId).history(
      "cycling",
    );
    const [cyclingRows, postgresRows, postgresCoverageRows] = await Promise.all([
      this.#store.query(
        cyclingActivitySchema,
        `/* analytical-load:cycling */
        WITH all_cycling AS (
          SELECT
            cycling.activity_id,
            toDate(toTimeZone(cycling.started_at, {timezone:String})) AS date,
            cycling.normalized_power,
            cycling.elapsed_seconds,
            activity.source_providers
          FROM analytics.cycling_activity AS cycling FINAL
          INNER JOIN analytics.deduped_activities AS activity FINAL
            ON activity.activity_id = cycling.activity_id AND activity.user_id = cycling.user_id
          WHERE cycling.user_id = {userId:UUID}
            AND cycling.is_deleted = 0 AND activity.is_deleted = 0
        ),
        first_observed AS (SELECT min(date) AS date FROM all_cycling)
        SELECT
          toString(all_cycling.activity_id) AS activity_id,
          toString(all_cycling.date) AS date,
          normalized_power,
          elapsed_seconds,
          source_providers,
          toString(first_observed.date) AS first_observed_date
        FROM all_cycling CROSS JOIN first_observed
        WHERE all_cycling.date BETWEEN toDate({calculationStart:String}) AND toDate({endDate:String})
        UNION ALL
        SELECT NULL, NULL, NULL, NULL, [], toString(date)
        FROM first_observed
        WHERE date IS NOT NULL
        ORDER BY date`,
        {
          userId: this.#userId,
          timezone: this.#timezone,
          calculationStart,
          endDate,
        },
      ),
      executeWithSchema(
        this.#db,
        postgresLoadSchema,
        sql`
          WITH activity_contributions AS (
            SELECT
              activity.id,
              activity.source_providers,
              (activity.started_at AT TIME ZONE ${this.#timezone})::date AS date,
              GREATEST(EXTRACT(EPOCH FROM (activity.ended_at - activity.started_at)) / 60.0, 0)
                AS duration_minutes,
              activity.perceived_exertion,
              climb.attempts,
              climb.entries,
              climb.entries_with_attempts,
              finger.load_kg_seconds,
              finger.entries AS finger_entries,
              strength.volume_kg_reps,
              strength.working_sets,
              strength.suspicious_sets
            FROM fitness.v_activity AS activity
            LEFT JOIN LATERAL (
              SELECT
                SUM(entry.attempt_count)::int AS attempts,
                COUNT(*)::int AS entries,
                COUNT(entry.attempt_count)::int AS entries_with_attempts
              FROM fitness.climbing_entry AS entry
              WHERE entry.activity_id = ANY(activity.member_activity_ids)
            ) AS climb ON TRUE
            LEFT JOIN LATERAL (
              SELECT
                NULL::real AS load_kg_seconds,
                COUNT(*)::int AS entries
              FROM fitness.finger_loading_entry AS entry
              WHERE entry.activity_id = ANY(activity.member_activity_ids)
            ) AS finger ON TRUE
            LEFT JOIN LATERAL (
              SELECT
                SUM(set.weight_kg * set.reps) FILTER (
                  WHERE set.set_type NOT IN ('warmup', 'rest')
                    AND set.weight_kg > 0 AND set.weight_kg <= 500
                    AND set.reps BETWEEN 1 AND 100
                )::real AS volume_kg_reps,
                COUNT(*) FILTER (
                  WHERE set.set_type NOT IN ('warmup', 'rest')
                    AND set.weight_kg > 0 AND set.weight_kg <= 500
                    AND set.reps BETWEEN 1 AND 100
                )::int AS working_sets,
                COUNT(*) FILTER (
                  WHERE set.set_type NOT IN ('warmup', 'rest')
                    AND (set.weight_kg IS NULL OR set.weight_kg <= 0 OR set.weight_kg > 500
                      OR set.reps IS NULL OR set.reps < 1 OR set.reps > 100)
                )::int AS suspicious_sets
              FROM fitness.strength_set AS set
              WHERE set.activity_id = ANY(activity.member_activity_ids)
            ) AS strength ON TRUE
            WHERE activity.user_id = ${this.#userId}::uuid
              AND (activity.started_at AT TIME ZONE ${this.#timezone})::date
                BETWEEN ${calculationStart}::date AND ${endDate}::date
          ),
          provider_contributions AS (
            SELECT
              contribution.date,
              provider_id,
              bool_or(contribution.duration_minutes > 0) AS has_session_rpe,
              bool_or(contribution.entries > 0) AS has_climbing,
              bool_or(contribution.finger_entries > 0) AS has_finger,
              bool_or(contribution.working_sets > 0 OR contribution.suspicious_sets > 0)
                AS has_strength
            FROM activity_contributions AS contribution
            CROSS JOIN LATERAL unnest(contribution.source_providers) AS provider_id
            GROUP BY contribution.date, provider_id
          ),
          providers_by_date AS (
            SELECT
              date,
              COALESCE(array_agg(provider_id ORDER BY provider_id)
                FILTER (WHERE has_session_rpe), ARRAY[]::text[])
                AS session_rpe_source_providers,
              COALESCE(array_agg(provider_id ORDER BY provider_id)
                FILTER (WHERE has_climbing), ARRAY[]::text[]) AS climbing_source_providers,
              COALESCE(array_agg(provider_id ORDER BY provider_id)
                FILTER (WHERE has_finger), ARRAY[]::text[]) AS finger_source_providers,
              COALESCE(array_agg(provider_id ORDER BY provider_id)
                FILTER (WHERE has_strength), ARRAY[]::text[]) AS strength_source_providers
            FROM provider_contributions
            GROUP BY date
          ),
          daily AS (
          SELECT
            date,
            SUM(duration_minutes * perceived_exertion)
              FILTER (WHERE perceived_exertion IS NOT NULL AND duration_minutes > 0)::real
              AS session_rpe_load,
            COUNT(*) FILTER (WHERE duration_minutes > 0)::int
              AS session_rpe_activities,
            COUNT(*) FILTER (WHERE perceived_exertion IS NOT NULL AND duration_minutes > 0)::int
              AS session_rpe_supported_activities,
            COALESCE(array_agg(DISTINCT id::text)
              FILTER (WHERE duration_minutes > 0), ARRAY[]::text[])
              AS session_rpe_activity_ids,
            SUM(attempts)::int AS climbing_attempts,
            SUM(entries)::int AS climbing_entries,
            SUM(entries_with_attempts)::int AS climbing_entries_with_attempts,
            SUM(duration_minutes) FILTER (WHERE entries > 0)::real AS climbing_session_minutes,
            COALESCE(array_agg(DISTINCT id::text) FILTER (WHERE entries > 0), ARRAY[]::text[])
              AS climbing_activity_ids,
            SUM(load_kg_seconds)::real AS finger_load_kg_seconds,
            SUM(finger_entries)::int AS finger_entries,
            COALESCE(array_agg(DISTINCT id::text) FILTER (WHERE finger_entries > 0), ARRAY[]::text[])
              AS finger_activity_ids,
            SUM(volume_kg_reps)::real AS strength_volume_kg_reps,
            SUM(working_sets)::int AS strength_working_sets,
            SUM(suspicious_sets)::int AS strength_suspicious_sets,
            COALESCE(array_agg(DISTINCT id::text)
              FILTER (WHERE working_sets > 0 OR suspicious_sets > 0), ARRAY[]::text[])
              AS strength_activity_ids
          FROM activity_contributions
          GROUP BY date
          )
          SELECT
            daily.date::text AS date,
            providers.session_rpe_source_providers,
            providers.climbing_source_providers,
            providers.finger_source_providers,
            providers.strength_source_providers,
            daily.session_rpe_load,
            daily.session_rpe_activities,
            daily.session_rpe_supported_activities,
            daily.session_rpe_activity_ids,
            daily.climbing_attempts,
            daily.climbing_entries,
            daily.climbing_entries_with_attempts,
            daily.climbing_session_minutes,
            daily.climbing_activity_ids,
            daily.finger_load_kg_seconds,
            daily.finger_entries,
            daily.finger_activity_ids,
            daily.strength_volume_kg_reps,
            daily.strength_working_sets,
            daily.strength_suspicious_sets,
            daily.strength_activity_ids
          FROM daily
          INNER JOIN providers_by_date AS providers ON providers.date = daily.date
          ORDER BY date
        `,
      ),
      executeWithSchema(
        this.#db,
        postgresCoverageSchema,
        sql`
          SELECT
            min((activity.started_at AT TIME ZONE ${this.#timezone})::date)
              FILTER (WHERE activity.perceived_exertion IS NOT NULL
                AND activity.ended_at > activity.started_at)::text AS first_session_rpe_date,
            min((activity.started_at AT TIME ZONE ${this.#timezone})::date)
              FILTER (WHERE EXISTS (
                SELECT 1 FROM fitness.climbing_entry AS entry
                WHERE entry.activity_id = ANY(activity.member_activity_ids)
              ))::text AS first_climbing_date,
            min((activity.started_at AT TIME ZONE ${this.#timezone})::date)
              FILTER (WHERE EXISTS (
                SELECT 1 FROM fitness.finger_loading_entry AS entry
                WHERE entry.activity_id = ANY(activity.member_activity_ids)
              ))::text AS first_finger_date,
            min((activity.started_at AT TIME ZONE ${this.#timezone})::date)
              FILTER (WHERE EXISTS (
                SELECT 1 FROM fitness.strength_set AS strength_set
                WHERE strength_set.activity_id = ANY(activity.member_activity_ids)
              ))::text AS first_strength_date
          FROM fitness.v_activity AS activity
          WHERE activity.user_id = ${this.#userId}::uuid
        `,
      ),
    ]);

    const realCyclingRows = cyclingRows.filter(
      (row): row is typeof row & { activity_id: string; date: string } =>
        row.activity_id != null && row.date != null,
    );
    const cyclingFirstObserved =
      cyclingRows.find((row) => row.first_observed_date)?.first_observed_date ?? null;
    const hrRows = await this.#loadHeartRate(settingsHistory, calculationStart, endDate);
    const heartRateFirstObserved = hrRows[0]?.first_observed_date ?? null;
    const postgresByDate = new Map(postgresRows.map((row) => [row.date, row]));
    const postgresCoverage = postgresCoverageRows[0];

    const channelMaps: Record<ChannelDefinition["key"], Map<string, BaseChannel>> = {
      cycling_power_tss: new Map(),
      heart_rate_zone_load: new Map(),
      session_rpe: new Map(),
      climbing_attempts: new Map(),
      finger_load: new Map(),
      strength_volume: new Map(),
    };
    const allDates = dateSeries(calculationStart, endDate);
    for (const date of allDates) {
      const dateCycling = realCyclingRows.filter((row) => row.date === date);
      const supportedCycling = dateCycling.flatMap((row) => {
        const setting = effectiveSetting(settingsHistory, date);
        if (
          setting?.ftp == null ||
          setting.ftp <= 0 ||
          row.normalized_power == null ||
          row.elapsed_seconds == null
        )
          return [];
        return [computePowerTss(row.normalized_power, setting.ftp, row.elapsed_seconds / 60)];
      });
      channelMaps.cycling_power_tss.set(
        date,
        dateCycling.length > 0 && supportedCycling.length === 0
          ? unavailableChannel(
              `No valid FTP was effective for ${dateCycling.length} cycling ${dateCycling.length === 1 ? "activity" : "activities"}.`,
              {
                sourceActivityIds: dateCycling.map((row) => row.activity_id),
                sourceProviders: mergeUnique(...dateCycling.map((row) => row.source_providers)),
                contributingRecords: dateCycling.length,
                supportedRecords: 0,
                firstObservedDate: cyclingFirstObserved,
                context: { activities: dateCycling.length },
              },
            )
          : dateCycling.length > 0
            ? {
                ...baseAvailable({
                  value: supportedCycling.reduce((total, value) => total + value, 0),
                  activityIds: dateCycling.map((row) => row.activity_id),
                  providers: mergeUnique(...dateCycling.map((row) => row.source_providers)),
                  records: supportedCycling.length,
                  firstObservedDate: cyclingFirstObserved,
                  context: { activities: dateCycling.length },
                }),
                status:
                  supportedCycling.length === dateCycling.length
                    ? ("available" as const)
                    : ("partial" as const),
                reason:
                  supportedCycling.length === dateCycling.length
                    ? null
                    : `${dateCycling.length - supportedCycling.length} cycling activities lacked FTP or normalized power.`,
                contributingRecords: dateCycling.length,
              }
            : emptyChannel(date, cyclingFirstObserved),
      );

      const heartRate = hrRows.find((row) => row.date === date);
      channelMaps.heart_rate_zone_load.set(
        date,
        heartRate
          ? baseAvailable({
              value: heartRate.load_points,
              activityIds: heartRate.activity_ids,
              providers: heartRate.source_providers,
              records: heartRate.activity_count,
              firstObservedDate: heartRate.first_observed_date,
              context: { covered_seconds: heartRate.covered_seconds },
            })
          : emptyChannel(date, heartRateFirstObserved),
      );

      const pgChannels = postgresChannels(postgresByDate.get(date), postgresCoverage);
      channelMaps.session_rpe.set(
        date,
        pgChannels?.sessionRpe ??
          emptyChannel(date, postgresCoverage?.first_session_rpe_date ?? null),
      );
      channelMaps.climbing_attempts.set(
        date,
        pgChannels?.climbing ?? emptyChannel(date, postgresCoverage?.first_climbing_date ?? null),
      );
      channelMaps.finger_load.set(
        date,
        pgChannels?.finger ?? emptyChannel(date, postgresCoverage?.first_finger_date ?? null),
      );
      channelMaps.strength_volume.set(
        date,
        pgChannels?.strength ?? emptyChannel(date, postgresCoverage?.first_strength_date ?? null),
      );
    }

    return {
      range: { start_date: startDate, end_date: endDate, timezone: this.#timezone },
      definitions: definitions(),
      total_daily_load: {
        value: null,
        reason:
          "Modality-specific loads use different units and are not treated as biologically interchangeable.",
      },
      rows: dateSeries(startDate, endDate).map((date) => ({
        date,
        channels: Object.fromEntries(
          CHANNELS.map(({ key, unit }) => {
            const channel = channelMaps[key].get(date) ?? emptyChannel(date, null);
            return [
              key,
              {
                daily_value: channel.dailyValue,
                unit,
                value_kind: "calculated" as const,
                status: channel.status,
                reason: channel.reason,
                source_activity_ids: channel.sourceActivityIds,
                source_providers: channel.sourceProviders,
                coverage: {
                  contributing_records: channel.contributingRecords,
                  supported_records: channel.supportedRecords,
                  first_observed_date: channel.firstObservedDate,
                },
                context: channel.context,
                rolling: rollingFor(date, channelMaps[key]),
              },
            ];
          }),
        ),
      })),
    };
  }

  async #loadHeartRate(
    settingsHistory: SportSettingsRow[],
    calculationStart: string,
    endDate: string,
  ): Promise<z.infer<typeof heartRateLoadSchema>[]> {
    const chronological = [...settingsHistory].sort((left, right) =>
      left.effectiveFrom.localeCompare(right.effectiveFrom),
    );
    const segments = chronological.flatMap((setting, index) => {
      const upperPcts = validZonePcts(setting.hrZonePcts);
      if (setting.thresholdHr == null || setting.thresholdHr <= 0 || upperPcts == null) return [];
      const next = chronological[index + 1];
      const segmentStart =
        setting.effectiveFrom > calculationStart ? setting.effectiveFrom : calculationStart;
      const segmentEnd = next ? dateShift(next.effectiveFrom, -1) : endDate;
      if (segmentStart > endDate || segmentEnd < calculationStart || segmentStart > segmentEnd)
        return [];
      return [
        {
          setting,
          upperPcts,
          segmentStart,
          segmentEnd: segmentEnd < endDate ? segmentEnd : endDate,
        },
      ];
    });
    const pages = await Promise.all(
      segments.map(({ setting, upperPcts, segmentStart, segmentEnd }) =>
        this.#store.query(
          heartRateLoadSchema,
          `/* analytical-load:heart-rate */
          WITH ordered AS (
            SELECT
              sensor.activity_id,
              toDate(toTimeZone(activity.started_at, {timezone:String})) AS date,
              sensor.recorded_at,
              sensor.scalar AS heart_rate,
              leadInFrame(sensor.recorded_at, 1, sensor.recorded_at) OVER (
                PARTITION BY sensor.activity_id ORDER BY sensor.recorded_at
                ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
              ) AS next_recorded_at,
              sensor.provider_id
            FROM analytics.activity_sensor_sample AS sensor FINAL
            INNER JOIN analytics.deduped_activities AS activity FINAL
              ON activity.activity_id = sensor.activity_id AND activity.user_id = sensor.user_id
            WHERE sensor.user_id = {userId:UUID}
              AND sensor.channel = 'heart_rate' AND sensor.scalar > 0 AND sensor.is_deleted = 0
              AND activity.is_deleted = 0
              AND toDate(toTimeZone(activity.started_at, {timezone:String}))
                BETWEEN toDate({segmentStart:String}) AND toDate({segmentEnd:String})
          ),
          weighted AS (
            SELECT *,
              least(greatest(dateDiff('second', recorded_at, next_recorded_at), 0), 10) AS seconds,
              arrayFirstIndex(pct -> heart_rate < {thresholdHr:Float64} * pct,
                {upperPcts:Array(Float64)}) AS bounded_zone
            FROM ordered
          )
          SELECT
            toString(date) AS date,
            sum(seconds * if(bounded_zone = 0, length({upperPcts:Array(Float64)}) + 1,
              bounded_zone)) / 60.0 AS load_points,
            sum(seconds) AS covered_seconds,
            uniqExact(activity_id) AS activity_count,
            arraySort(groupUniqArray(toString(activity_id))) AS activity_ids,
            arraySort(groupUniqArrayIf(provider_id, provider_id != '')) AS source_providers,
            toString(min(date) OVER ()) AS first_observed_date
          FROM weighted
          GROUP BY date
          ORDER BY date`,
          {
            userId: this.#userId,
            timezone: this.#timezone,
            segmentStart,
            segmentEnd,
            thresholdHr: setting.thresholdHr,
            upperPcts,
          },
        ),
      ),
    );
    return pages.flat().sort((left, right) => left.date.localeCompare(right.date));
  }
}
