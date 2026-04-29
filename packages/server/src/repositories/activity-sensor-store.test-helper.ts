import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import { sql } from "drizzle-orm";
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

const CURVE_DURATIONS_SECONDS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200];

export function createPostgresTestActivitySensorStore(db: ExecutableDatabase): ActivitySensorStore {
  return new PostgresTestActivitySensorStore(db);
}

class PostgresTestActivitySensorStore implements ActivitySensorStore {
  readonly #db: ExecutableDatabase;

  constructor(db: ExecutableDatabase) {
    this.#db = db;
  }

  async getActivitySummaries(activityIds: string[]): Promise<SummaryRow[]> {
    if (activityIds.length === 0) {
      return [];
    }

    return this.#db.execute<SummaryRow>(
      sql`SELECT
            activity_id::text AS activity_id,
            avg_hr,
            max_hr,
            avg_power,
            max_power,
            avg_speed,
            max_speed,
            avg_cadence,
            total_distance,
            elevation_gain_m,
            elevation_loss_m,
            sample_count
          FROM fitness.activity_summary
          WHERE activity_id IN (${sql.join(
            activityIds.map((activityId) => sql`${activityId}::uuid`),
            sql`, `,
          )})`,
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
    const rows = await this.#db.execute<StreamPointRow>(
      sql`SELECT
            recorded_at::text AS recorded_at,
            MAX(scalar) FILTER (WHERE channel = 'heart_rate')::real AS heart_rate,
            MAX(scalar) FILTER (WHERE channel = 'power')::real AS power,
            MAX(scalar) FILTER (WHERE channel = 'speed')::real AS speed,
            MAX(scalar) FILTER (WHERE channel = 'cadence')::real AS cadence,
            MAX(scalar) FILTER (WHERE channel = 'altitude')::real AS altitude,
            MAX(scalar) FILTER (WHERE channel = 'lat')::real AS lat,
            MAX(scalar) FILTER (WHERE channel = 'lng')::real AS lng
          FROM fitness.deduped_sensor
          WHERE user_id = ${window.userId}::uuid
            AND activity_id = ${window.activityId}::uuid
            AND channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude', 'lat', 'lng')
          GROUP BY recorded_at
          ORDER BY recorded_at`,
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
    return [1, 2, 3, 4, 5].map((zone) => ({
      zone,
      seconds: values.filter((value) => valueInHeartRateZone(value, zone, maxHr, restingHr)).length,
    }));
  }

  async getPowerZoneSeconds(window: ActivitySensorWindow, ftp: number): Promise<ZoneRow[]> {
    const values = await this.#activityChannelValues(window, "power");
    return [1, 2, 3, 4, 5, 6, 7].map((zone) => ({
      zone,
      seconds: values.filter((value) => valueInPowerZone(value, zone, ftp)).length,
    }));
  }

  async #activityChannelValues(window: ActivitySensorWindow, channel: string): Promise<number[]> {
    const rows = await this.#db.execute<{ scalar: number }>(
      sql`SELECT scalar::real AS scalar
          FROM fitness.deduped_sensor
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
    return this.#db.execute<SampleRow>(
      sql`SELECT
            sensor.activity_id::text AS activity_id,
            TO_CHAR((activity.started_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS activity_date,
            activity.name AS activity_name,
            sensor.recorded_at::text AS recorded_at,
            sensor.scalar::real AS scalar
          FROM fitness.deduped_sensor sensor
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
          bestRows.set(durationSeconds, {
            duration_seconds: durationSeconds,
            best_value: bestValue,
            activity_date: activitySamples[0]?.activity_date ?? "",
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
