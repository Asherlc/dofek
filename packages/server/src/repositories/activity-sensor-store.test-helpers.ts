import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import type {
  ActivitySensorStore,
  ActivitySensorWindow,
  StreamPointRow,
} from "./activity-repository.ts";

interface ExecutableDatabase {
  execute<TRow extends object>(query: unknown): Promise<TRow[]>;
}

interface SummaryRow {
  activity_id: string;
  avg_hr: number | null;
  max_hr: number | null;
  avg_power: number | null;
  max_power: number | null;
  avg_speed: number | null;
  max_speed: number | null;
  avg_cadence: number | null;
  total_distance: number | null;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
  sample_count: number | null;
}

interface SampleRow {
  activity_id: string;
  activity_date: string;
  activity_name: string | null;
  recorded_at: string;
  scalar: number;
}

interface ZoneRow {
  zone: number;
  seconds: number;
}

const summaryRowSchema = z.object({
  activity_id: z.string(),
  avg_hr: z.coerce.number().nullable(),
  max_hr: z.coerce.number().nullable(),
  avg_power: z.coerce.number().nullable(),
  max_power: z.coerce.number().nullable(),
  avg_speed: z.coerce.number().nullable(),
  max_speed: z.coerce.number().nullable(),
  avg_cadence: z.coerce.number().nullable(),
  total_distance: z.coerce.number().nullable(),
  elevation_gain_m: z.coerce.number().nullable(),
  elevation_loss_m: z.coerce.number().nullable(),
  sample_count: z.coerce.number().nullable(),
});

const sampleRowSchema = z.object({
  activity_id: z.string(),
  activity_date: dateStringSchema,
  activity_name: z.string().nullable(),
  recorded_at: z.string(),
  scalar: z.coerce.number(),
});

const streamPointRowSchema = z.object({
  recorded_at: z.string(),
  heart_rate: z.coerce.number().nullable(),
  power: z.coerce.number().nullable(),
  speed: z.coerce.number().nullable(),
  cadence: z.coerce.number().nullable(),
  altitude: z.coerce.number().nullable(),
  lat: z.coerce.number().nullable(),
  lng: z.coerce.number().nullable(),
});

const scalarRowSchema = z.object({
  scalar: z.coerce.number(),
});

const CURVE_DURATIONS_SECONDS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200];
const OUTDOOR_VO2_MAX_ACTIVITY_TYPES = ["running", "trail_running", "walking", "hiking"] as const;

const vo2MaxEstimateRowSchema = z.object({
  activity_id: z.string(),
  activity_date: dateStringSchema,
  method: z.string(),
  vo2max: z.coerce.number(),
});

type Vo2MaxEstimateRow = z.infer<typeof vo2MaxEstimateRowSchema>;

export function createPostgresTestActivitySensorStore(db: ExecutableDatabase): ActivitySensorStore {
  return new PostgresTestActivitySensorStore(db);
}

class PostgresTestActivitySensorStore implements ActivitySensorStore {
  readonly #db: ExecutableDatabase;

  constructor(db: ExecutableDatabase) {
    this.#db = db;
  }

  async query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params: Record<string, unknown> = {},
  ): Promise<z.infer<TSchema>[]> {
    if (isPolarizationTrendQuery(query)) {
      return this.#queryPolarizationTrend(schema, params);
    }

    throw new Error(
      `PostgresTestActivitySensorStore does not support this ClickHouse query shape: ${query.slice(0, 120)}`,
    );
  }

  async #queryPolarizationTrend<TSchema extends z.ZodType>(
    schema: TSchema,
    params: Record<string, unknown>,
  ): Promise<z.infer<TSchema>[]> {
    const userId = requiredStringParam(params, "userId");
    const timezone = requiredStringParam(params, "timezone");
    const days = requiredNumberParam(params, "days");
    const zoneOneMaximum = requiredNumberParam(params, "p1");
    const zoneTwoMaximum = requiredNumberParam(params, "p2");
    const enduranceTypes = requiredStringArrayParam(params, "enduranceTypes");

    const rows = await executeWithSchema(
      this.#db,
      schema,
      sql`WITH activity_meta AS (
            SELECT
              activity.id AS id,
              (activity.started_at AT TIME ZONE ${timezone})::date AS activity_date,
              user_profile.max_hr AS max_hr
            FROM fitness.v_activity activity
            INNER JOIN fitness.user_profile user_profile
              ON user_profile.id = activity.user_id
            WHERE activity.user_id = ${userId}::uuid
              AND activity.activity_type IN (${sql.join(
                enduranceTypes.map((activityType) => sql`${activityType}`),
                sql`, `,
              )})
              AND activity.started_at > CURRENT_TIMESTAMP - ${days}::int * INTERVAL '1 day'
              AND user_profile.max_hr IS NOT NULL
          )
          SELECT
            MAX(activity_meta.max_hr)::real AS max_hr,
            to_char(date_trunc('week', activity_meta.activity_date::timestamp)::date, 'YYYY-MM-DD') AS week,
            COUNT(*) FILTER (
              WHERE sensor.scalar < activity_meta.max_hr * ${zoneOneMaximum}
            )::int AS z1_seconds,
            COUNT(*) FILTER (
              WHERE sensor.scalar >= activity_meta.max_hr * ${zoneOneMaximum}
                AND sensor.scalar < activity_meta.max_hr * ${zoneTwoMaximum}
            )::int AS z2_seconds,
            COUNT(*) FILTER (
              WHERE sensor.scalar >= activity_meta.max_hr * ${zoneTwoMaximum}
            )::int AS z3_seconds
          FROM fitness.metric_stream sensor
          INNER JOIN activity_meta ON activity_meta.id = sensor.activity_id
          WHERE sensor.channel = 'heart_rate'
            AND sensor.scalar IS NOT NULL
          GROUP BY date_trunc('week', activity_meta.activity_date::timestamp)::date
          ORDER BY week`,
    );

    return rows;
  }

  async getActivitySummaries(activityIds: string[]): Promise<SummaryRow[]> {
    if (activityIds.length === 0) {
      return [];
    }

    return executeWithSchema(
      this.#db,
      summaryRowSchema,
      sql`SELECT
            activity.id::text AS activity_id,
            AVG(sensor.scalar) FILTER (WHERE sensor.channel = 'heart_rate')::real AS avg_hr,
            MAX(sensor.scalar) FILTER (WHERE sensor.channel = 'heart_rate')::real AS max_hr,
            AVG(sensor.scalar) FILTER (
              WHERE sensor.channel = 'power' AND sensor.scalar > 0
            )::real AS avg_power,
            MAX(sensor.scalar) FILTER (
              WHERE sensor.channel = 'power' AND sensor.scalar > 0
            )::real AS max_power,
            AVG(sensor.scalar) FILTER (WHERE sensor.channel = 'speed')::real AS avg_speed,
            MAX(sensor.scalar) FILTER (WHERE sensor.channel = 'speed')::real AS max_speed,
            AVG(sensor.scalar) FILTER (
              WHERE sensor.channel = 'cadence' AND sensor.scalar > 0
            )::real AS avg_cadence,
            MAX(sensor.scalar) FILTER (WHERE sensor.channel = 'distance')::real AS total_distance,
            NULL::real AS elevation_gain_m,
            NULL::real AS elevation_loss_m,
            COUNT(sensor.scalar)::int AS sample_count
          FROM fitness.v_activity activity
          LEFT JOIN fitness.metric_stream sensor
            ON sensor.activity_id = activity.id
           AND sensor.scalar IS NOT NULL
          WHERE activity.id IN (${sql.join(
            activityIds.map((activityId) => sql`${activityId}::uuid`),
            sql`, `,
          )})
          GROUP BY activity.id`,
    );
  }

  async getPowerCurveSamples(
    days: number,
    userId: string,
    timezone: string,
  ): Promise<
    Array<{ activity_id: string; activity_date: string; power: number; interval_s: number }>
  > {
    const samples = await this.#samplesForChannel(days, userId, timezone, "power", true);
    return this.#samplesWithInterval(samples).map((sample) => ({
      activity_id: sample.activity_id,
      activity_date: sample.activity_date,
      power: sample.scalar,
      interval_s: sample.interval_s,
    }));
  }

  async getNormalizedPowerSamples(
    days: number,
    userId: string,
    timezone: string,
  ): Promise<
    Array<{
      activity_id: string;
      activity_date: string;
      activity_name: string | null;
      power: number;
      interval_s: number;
    }>
  > {
    const samples = await this.#samplesForChannel(days, userId, timezone, "power", true);
    const sampleCounts = new Map<string, number>();
    for (const sample of samples) {
      sampleCounts.set(sample.activity_id, (sampleCounts.get(sample.activity_id) ?? 0) + 1);
    }

    return this.#samplesWithInterval(samples)
      .filter((sample) => (sampleCounts.get(sample.activity_id) ?? 0) >= 240)
      .map((sample) => ({
        activity_id: sample.activity_id,
        activity_date: sample.activity_date,
        activity_name: sample.activity_name,
        power: sample.scalar,
        interval_s: sample.interval_s,
      }));
  }

  async getVo2MaxEstimates(
    endDate: string,
    days: number,
    userId: string,
    timezone: string,
  ): Promise<Vo2MaxEstimateRow[]> {
    return executeWithSchema(
      this.#db,
      vo2MaxEstimateRowSchema,
      sql`WITH activities AS (
            SELECT
              activity.id,
              activity.started_at,
              activity.activity_type,
              (activity.started_at AT TIME ZONE ${timezone})::date AS activity_date
            FROM fitness.v_activity activity
            WHERE activity.user_id = ${userId}::uuid
              AND (activity.started_at AT TIME ZONE ${timezone})::date > (${endDate}::date - ${days}::int)
              AND (activity.started_at AT TIME ZONE ${timezone})::date <= ${endDate}::date
              AND activity.activity_type IN (${sql.join(
                ENDURANCE_ACTIVITY_TYPES.map((activityType) => sql`${activityType}`),
                sql`, `,
              )})
          ),
          resting_heart_rate AS (
            SELECT DISTINCT
              activities.activity_date AS date,
              user_profile.resting_hr::real AS resting_hr
            FROM activities
            JOIN fitness.user_profile user_profile
              ON user_profile.id = ${userId}::uuid
            WHERE user_profile.resting_hr IS NOT NULL
          ),
          latest_weight AS (
            SELECT body.scalar AS weight_kg
            FROM fitness.metric_stream body
            WHERE body.user_id = ${userId}::uuid
              AND body.channel = 'body_weight'
              AND body.scalar IS NOT NULL
            ORDER BY body.recorded_at DESC
            LIMIT 1
          ),
          power_samples AS (
            SELECT
              sensor.activity_id,
              activities.activity_date,
              sensor.recorded_at,
              sensor.scalar AS power,
              ROW_NUMBER() OVER (
                PARTITION BY sensor.activity_id
                ORDER BY sensor.recorded_at
              ) AS row_number,
              SUM(sensor.scalar) OVER (
                PARTITION BY sensor.activity_id
                ORDER BY sensor.recorded_at
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              ) AS cumulative_sum
            FROM fitness.metric_stream sensor
            JOIN activities ON activities.id = sensor.activity_id
            WHERE sensor.user_id = ${userId}::uuid
              AND sensor.channel = 'power'
              AND sensor.scalar > 0
          ),
          power_sample_rate AS (
            SELECT
              activity_id,
              GREATEST(
                ROUND(EXTRACT(EPOCH FROM (MAX(recorded_at) - MIN(recorded_at))) / NULLIF(COUNT(*) - 1, 0))::int,
                1
              ) AS interval_s
            FROM power_samples
            GROUP BY activity_id
            HAVING COUNT(*) >= 240
          ),
          power_windows AS (
            SELECT
              power_samples.activity_id,
              power_samples.activity_date,
              (
                power_samples.cumulative_sum - COALESCE(previous_sample.cumulative_sum, 0)
              ) / sample_windows.window_samples::float AS five_minute_power_watts
            FROM power_samples
            JOIN (
              SELECT
                activity_id,
                GREATEST(1, ROUND(300.0 / interval_s)::int) AS window_samples
              FROM power_sample_rate
            ) sample_windows
              ON sample_windows.activity_id = power_samples.activity_id
            LEFT JOIN power_samples previous_sample
              ON previous_sample.activity_id = power_samples.activity_id
             AND previous_sample.row_number = power_samples.row_number - sample_windows.window_samples
            WHERE power_samples.row_number >= sample_windows.window_samples
          ),
          cycling_estimates AS (
            SELECT
              power_windows.activity_id::text AS activity_id,
              power_windows.activity_date::text AS activity_date,
              'cycling_power' AS method,
              ((MAX(power_windows.five_minute_power_watts) / MAX(latest_weight.weight_kg)) * 10.8 + 7)::real AS vo2max
            FROM power_windows
            CROSS JOIN latest_weight
            GROUP BY power_windows.activity_id, power_windows.activity_date
            HAVING MAX(power_windows.five_minute_power_watts) BETWEEN 50 AND 700
              AND ((MAX(power_windows.five_minute_power_watts) / MAX(latest_weight.weight_kg)) * 10.8 + 7) > 0
          ),
          acsm_segments AS (
            SELECT
              sensor.activity_id,
              activities.activity_date,
              FLOOR(EXTRACT(EPOCH FROM (sensor.recorded_at - activities.started_at)) / 300)::int AS segment_index,
              AVG(sensor.scalar) FILTER (WHERE sensor.channel = 'speed') * 60 AS speed_meters_per_minute,
              AVG(sensor.scalar) FILTER (WHERE sensor.channel = 'heart_rate') AS average_heart_rate,
              (
                MAX(sensor.scalar) FILTER (WHERE sensor.channel = 'altitude')
                - MIN(sensor.scalar) FILTER (WHERE sensor.channel = 'altitude')
              ) / NULLIF(AVG(sensor.scalar) FILTER (WHERE sensor.channel = 'speed') * 300, 0) AS grade_fraction
            FROM fitness.metric_stream sensor
            JOIN activities ON activities.id = sensor.activity_id
            WHERE sensor.user_id = ${userId}::uuid
              AND activities.activity_type IN (${sql.join(
                OUTDOOR_VO2_MAX_ACTIVITY_TYPES.map((activityType) => sql`${activityType}`),
                sql`, `,
              )})
              AND sensor.channel IN ('speed', 'heart_rate', 'altitude')
              AND sensor.scalar IS NOT NULL
            GROUP BY sensor.activity_id, activities.started_at, activities.activity_date, segment_index
            HAVING COUNT(*) FILTER (WHERE sensor.channel = 'speed') >= 60
              AND COUNT(*) FILTER (WHERE sensor.channel = 'heart_rate') >= 60
              AND COUNT(*) FILTER (WHERE sensor.channel = 'altitude') >= 2
          ),
          acsm_estimates AS (
            SELECT
              acsm_segments.activity_id::text AS activity_id,
              acsm_segments.activity_date::text AS activity_date,
              'submaximal_acsm' AS method,
              (
                CASE
                  WHEN acsm_segments.speed_meters_per_minute >= 134
                    THEN 0.2 * acsm_segments.speed_meters_per_minute
                      + 0.9 * acsm_segments.speed_meters_per_minute * acsm_segments.grade_fraction
                      + 3.5
                  ELSE 0.1 * acsm_segments.speed_meters_per_minute
                    + 1.8 * acsm_segments.speed_meters_per_minute * acsm_segments.grade_fraction
                    + 3.5
                END
              ) / NULLIF(
                (acsm_segments.average_heart_rate - resting.resting_hr)
                  / (user_profile.max_hr - resting.resting_hr),
                0
              ) AS vo2max
            FROM acsm_segments
            JOIN fitness.user_profile user_profile
              ON user_profile.id = ${userId}::uuid
            JOIN LATERAL (
              SELECT drhr.resting_hr
              FROM resting_heart_rate drhr
              WHERE drhr.date <= acsm_segments.activity_date
                AND drhr.resting_hr IS NOT NULL
              ORDER BY drhr.date DESC
              LIMIT 1
            ) resting ON true
            WHERE user_profile.max_hr IS NOT NULL
              AND user_profile.max_hr > resting.resting_hr
              AND acsm_segments.speed_meters_per_minute BETWEEN 40 AND 450
              AND acsm_segments.grade_fraction BETWEEN -0.15 AND 0.15
              AND (
                (acsm_segments.average_heart_rate - resting.resting_hr)
                  / (user_profile.max_hr - resting.resting_hr)
              ) >= 0.6
              AND (
                (acsm_segments.average_heart_rate - resting.resting_hr)
                  / (user_profile.max_hr - resting.resting_hr)
              ) < 1
          )
          SELECT activity_id, activity_date, method, vo2max
          FROM cycling_estimates
          WHERE vo2max BETWEEN 1 AND 100
          UNION ALL
          SELECT activity_id, activity_date, method, vo2max
          FROM acsm_estimates
          WHERE vo2max BETWEEN 1 AND 100
          ORDER BY activity_date, activity_id, method`,
    );
  }

  async getHeartRateCurveRows(
    days: number,
    userId: string,
    timezone: string,
  ): Promise<Array<{ duration_seconds: number; best_hr: number; activity_date: string }>> {
    const samples = await this.#samplesForChannel(days, userId, timezone, "heart_rate", true);
    return this.#bestAverageByDuration(samples).map((row) => ({
      duration_seconds: row.duration_seconds,
      best_hr: Math.round(row.best_value),
      activity_date: row.activity_date,
    }));
  }

  async getPaceCurveRows(
    days: number,
    userId: string,
    timezone: string,
  ): Promise<Array<{ duration_seconds: number; best_pace: number; activity_date: string }>> {
    const samples = await this.#samplesForChannel(days, userId, timezone, "speed", true);
    return this.#bestAverageByDuration(samples)
      .filter((row) => row.best_value > 0)
      .map((row) => ({
        duration_seconds: row.duration_seconds,
        best_pace: Math.round((1000 / row.best_value) * 10) / 10,
        activity_date: row.activity_date,
      }));
  }

  async getStream(window: ActivitySensorWindow, maxPoints: number): Promise<StreamPointRow[]> {
    // Test shim only: production stream reads use ClickHouse analytics.deduped_location.
    const rows = await executeWithSchema(
      this.#db,
      streamPointRowSchema,
      sql`WITH
          scalar_samples AS (
            SELECT
              recorded_at,
              MAX(scalar) FILTER (WHERE channel = 'heart_rate')::real AS heart_rate,
              MAX(scalar) FILTER (WHERE channel = 'power')::real AS power,
              MAX(scalar) FILTER (WHERE channel = 'speed')::real AS speed,
              MAX(scalar) FILTER (WHERE channel = 'cadence')::real AS cadence,
              MAX(scalar) FILTER (WHERE channel = 'altitude')::real AS altitude
            FROM fitness.metric_stream
            WHERE user_id = ${window.userId}::uuid
              AND activity_id = ${window.activityId}::uuid
              AND channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude')
            GROUP BY recorded_at
          ),
          location_samples AS (
            SELECT
              recorded_at,
              MAX(public.ST_Y(point))::real AS lat,
              MAX(public.ST_X(point))::real AS lng
            FROM fitness.metric_stream
            WHERE user_id = ${window.userId}::uuid
              AND activity_id = ${window.activityId}::uuid
              AND channel = 'location'
              AND point IS NOT NULL
            GROUP BY recorded_at
          ),
          sample_times AS (
            SELECT recorded_at FROM scalar_samples
            UNION
            SELECT recorded_at FROM location_samples
          )
          SELECT
            sample_times.recorded_at::text AS recorded_at,
            scalar_samples.heart_rate,
            scalar_samples.power,
            scalar_samples.speed,
            scalar_samples.cadence,
            scalar_samples.altitude,
            location_samples.lat,
            location_samples.lng
          FROM sample_times
          LEFT JOIN scalar_samples
            ON scalar_samples.recorded_at = sample_times.recorded_at
          LEFT JOIN location_samples
            ON location_samples.recorded_at = sample_times.recorded_at
          ORDER BY sample_times.recorded_at`,
    );

    const stride = Math.max(1, Math.floor(rows.length / maxPoints));
    return rows.filter((_, index) => index % stride === 0);
  }

  async getHeartRateZoneSeconds(
    window: ActivitySensorWindow,
    maxHr: number,
    restingHr: number,
  ): Promise<ZoneRow[]> {
    const values = await this.#activityChannelValues(window, "heart_rate");

    const calculateZoneRows = (zoneValues: number[]) =>
      [1, 2, 3, 4, 5].map((zone) => ({
        zone,
        seconds: zoneValues.filter((value) => valueInHeartRateZone(value, zone, maxHr, restingHr))
          .length,
      }));

    return calculateZoneRows(values);
  }

  async getPowerZoneSeconds(window: ActivitySensorWindow, ftp: number): Promise<ZoneRow[]> {
    const values = await this.#activityChannelValues(window, "power");
    return [1, 2, 3, 4, 5, 6, 7].map((zone) => ({
      zone,
      seconds: values.filter((value) => valueInPowerZone(value, zone, ftp)).length,
    }));
  }

  async #activityChannelValues(window: ActivitySensorWindow, channel: string): Promise<number[]> {
    const rows = await executeWithSchema(
      this.#db,
      scalarRowSchema,
      sql`SELECT scalar::real AS scalar
          FROM fitness.metric_stream
          WHERE user_id = ${window.userId}::uuid
            AND activity_id = ${window.activityId}::uuid
            AND channel = ${channel}
            AND scalar IS NOT NULL
          ORDER BY recorded_at`,
    );
    return rows.map((row) => row.scalar);
  }

  async #samplesForChannel(
    days: number,
    userId: string,
    timezone: string,
    channel: string,
    requirePositive: boolean,
  ): Promise<SampleRow[]> {
    return executeWithSchema(
      this.#db,
      sampleRowSchema,
      sql`SELECT
            sensor.activity_id::text AS activity_id,
            TO_CHAR((activity.started_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS activity_date,
            activity.name AS activity_name,
            sensor.recorded_at::text AS recorded_at,
            sensor.scalar::real AS scalar
          FROM fitness.metric_stream sensor
          JOIN fitness.v_activity activity ON activity.id = sensor.activity_id
          WHERE sensor.user_id = ${userId}::uuid
            AND sensor.channel = ${channel}
            AND sensor.scalar IS NOT NULL
            AND (${requirePositive} = false OR sensor.scalar > 0)
            AND activity.started_at > CURRENT_TIMESTAMP - ${days}::int * INTERVAL '1 day'
            AND activity.activity_type IN (${sql.join(
              ENDURANCE_ACTIVITY_TYPES.map((activityType) => sql`${activityType}`),
              sql`, `,
            )})
          ORDER BY sensor.activity_id, sensor.recorded_at`,
    );
  }

  #samplesWithInterval(samples: SampleRow[]): Array<SampleRow & { interval_s: number }> {
    const samplesByActivity = groupSamplesByActivity(samples);
    return samples.map((sample) => ({
      ...sample,
      interval_s: sampleIntervalSeconds(samplesByActivity.get(sample.activity_id) ?? []),
    }));
  }

  #bestAverageByDuration(
    samples: SampleRow[],
  ): Array<{ duration_seconds: number; best_value: number; activity_date: string }> {
    const samplesByActivity = groupSamplesByActivity(samples);
    const bestRows = new Map<
      number,
      { duration_seconds: number; best_value: number; activity_date: string }
    >();

    for (const activitySamples of samplesByActivity.values()) {
      const intervalSeconds = sampleIntervalSeconds(activitySamples);
      const values = activitySamples.map((sample) => sample.scalar);
      for (const durationSeconds of CURVE_DURATIONS_SECONDS) {
        const windowSize = Math.max(1, Math.round(durationSeconds / intervalSeconds));
        if (values.length < windowSize) {
          continue;
        }
        const bestValue = bestMovingAverage(values, windowSize);
        const existing = bestRows.get(durationSeconds);
        if (!existing || bestValue > existing.best_value) {
          const activityDate = activitySamples[0]?.activity_date;
          if (!activityDate) {
            continue;
          }
          bestRows.set(durationSeconds, {
            duration_seconds: durationSeconds,
            best_value: bestValue,
            activity_date: activityDate,
          });
        }
      }
    }

    return [...bestRows.values()].sort(
      (left, right) => left.duration_seconds - right.duration_seconds,
    );
  }
}

function groupSamplesByActivity(samples: SampleRow[]): Map<string, SampleRow[]> {
  const samplesByActivity = new Map<string, SampleRow[]>();
  for (const sample of samples) {
    const activitySamples = samplesByActivity.get(sample.activity_id) ?? [];
    activitySamples.push(sample);
    samplesByActivity.set(sample.activity_id, activitySamples);
  }
  return samplesByActivity;
}

function sampleIntervalSeconds(samples: SampleRow[]): number {
  if (samples.length < 2) {
    return 1;
  }
  const firstTimestamp = Date.parse(samples[0]?.recorded_at ?? "");
  const lastTimestamp = Date.parse(samples[samples.length - 1]?.recorded_at ?? "");
  const durationSeconds = Math.max(1, Math.round((lastTimestamp - firstTimestamp) / 1000));
  return Math.max(1, Math.round(durationSeconds / (samples.length - 1)));
}

function isPolarizationTrendQuery(query: string): boolean {
  return (
    query.includes("countIf(ds.scalar < am.max_hr") &&
    query.includes("analytics.deduped_sensor") &&
    query.includes("analytics.activity_summary")
  );
}

function requiredStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected string query param: ${key}`);
  }
  return value;
}

function requiredNumberParam(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected number query param: ${key}`);
  }
  return value;
}

function requiredStringArrayParam(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Expected string array query param: ${key}`);
  }
  return value;
}

function bestMovingAverage(values: number[], windowSize: number): number {
  let runningSum = 0;
  let bestAverage = 0;
  for (let index = 0; index < values.length; index += 1) {
    runningSum += values[index] ?? 0;
    if (index >= windowSize) {
      runningSum -= values[index - windowSize] ?? 0;
    }
    if (index >= windowSize - 1) {
      bestAverage = Math.max(bestAverage, runningSum / windowSize);
    }
  }
  return bestAverage;
}

function valueInHeartRateZone(
  value: number,
  zone: number,
  maxHr: number,
  restingHr: number,
): boolean {
  const reserve = maxHr - restingHr;
  const lower = restingHr + reserve * (0.4 + zone * 0.1);
  if (zone === 5) {
    return value >= lower;
  }
  const upper = restingHr + reserve * (0.5 + zone * 0.1);
  return value >= lower && value < upper;
}

function valueInPowerZone(value: number, zone: number, ftp: number): boolean {
  switch (zone) {
    case 1:
      return value < ftp * 0.55;
    case 2:
      return value >= ftp * 0.55 && value < ftp * 0.75;
    case 3:
      return value >= ftp * 0.75 && value < ftp * 0.9;
    case 4:
      return value >= ftp * 0.9 && value < ftp * 1.05;
    case 5:
      return value >= ftp * 1.05 && value < ftp * 1.2;
    case 6:
      return value >= ftp * 1.2 && value < ftp * 1.5;
    case 7:
      return value >= ftp * 1.5;
    default:
      return false;
  }
}
