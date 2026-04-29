import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import type {
  ActivitySensorStore,
  ActivitySensorWindow,
  StreamPointRow,
} from "./activity-repository.ts";

interface ClickHouseJsonResult<TRow> {
  json(): Promise<TRow[]>;
}

export interface ClickHouseQueryClient {
  query<TRow extends object>(options: {
    query: string;
    format: "JSONEachRow";
    query_params: Record<string, unknown>;
  }): Promise<ClickHouseJsonResult<TRow>>;
}

interface PowerZoneSecondRow {
  zone: number;
  seconds: number;
}

interface HeartRateZoneSecondRow {
  zone: number;
  seconds: number;
}

interface PowerCurveSampleRow {
  activity_id: string;
  activity_date: string;
  power: number;
  interval_s: number;
}

interface NormalizedPowerSampleRow {
  activity_id: string;
  activity_date: string;
  activity_name: string | null;
  power: number;
  interval_s: number;
}

export interface ActivitySummaryReadModelRow {
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

function queryParams(window: ActivitySensorWindow, extra: Record<string, unknown>) {
  return {
    activityId: window.activityId,
    userId: window.userId,
    ...extra,
  };
}

function userWindowParams(days: number, userId: string, timezone: string) {
  return {
    days,
    userId,
    timezone,
    enduranceActivityTypes: [...ENDURANCE_ACTIVITY_TYPES],
  };
}

function normalizeClickHouseTimestamp(value: string): string {
  const timestamp = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return new Date(timestamp).toISOString();
}

function dedupedSamplesSql(channelPredicate = "1 = 1"): string {
  return `
    WITH deduped_samples AS (
      SELECT
        recorded_at,
        channel,
        scalar
      FROM analytics.deduped_sensor
      WHERE user_id = {userId:UUID}
        AND activity_id = {activityId:UUID}
        AND ${channelPredicate}
    )
  `;
}

export class ClickHouseActivitySensorStore implements ActivitySensorStore {
  readonly #client: ClickHouseQueryClient;

  constructor(client: ClickHouseQueryClient) {
    this.#client = client;
  }

  async getActivitySummaries(activityIds: string[]): Promise<ActivitySummaryReadModelRow[]> {
    if (activityIds.length === 0) {
      return [];
    }
    const result = await this.#client.query<ActivitySummaryReadModelRow>({
      query: `
        SELECT
          toString(activity_id) AS activity_id,
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
        FROM analytics.activity_summary
        WHERE activity_id IN {activityIds:Array(UUID)}
      `,
      format: "JSONEachRow",
      query_params: { activityIds },
    });
    return result.json();
  }

  async getPowerCurveSamples(
    days: number,
    userId: string,
    timezone: string,
  ): Promise<PowerCurveSampleRow[]> {
    const result = await this.#client.query<PowerCurveSampleRow>({
      query: `
        WITH activity_info AS (
          SELECT
            deduped_samples.activity_id AS activity_id,
            toString(toDate(toTimeZone(activity.started_at, {timezone:String}))) AS activity_date,
            greatest(
              toInt32(round(
                dateDiff('second', min(deduped_samples.recorded_at), max(deduped_samples.recorded_at))
                / nullIf(count() - 1, 0)
              )),
              1
            ) AS interval_s
          FROM analytics.deduped_sensor AS deduped_samples
          INNER JOIN postgres_fitness_live.v_activity AS activity
            ON activity.id = deduped_samples.activity_id
          WHERE deduped_samples.user_id = {userId:UUID}
            AND deduped_samples.channel = 'power'
            AND activity.started_at > now() - toIntervalDay({days:UInt32})
            AND has({enduranceActivityTypes:Array(String)}, activity.activity_type)
          GROUP BY deduped_samples.activity_id, activity.started_at
          HAVING count() > 1
        )
        SELECT
          toString(deduped_samples.activity_id) AS activity_id,
          activity_info.activity_date AS activity_date,
          ifNull(deduped_samples.scalar, 0) AS power,
          activity_info.interval_s AS interval_s
        FROM analytics.deduped_sensor AS deduped_samples
        INNER JOIN activity_info
          ON activity_info.activity_id = deduped_samples.activity_id
        WHERE deduped_samples.channel = 'power'
        ORDER BY deduped_samples.activity_id, deduped_samples.recorded_at
      `,
      format: "JSONEachRow",
      query_params: userWindowParams(days, userId, timezone),
    });
    return result.json();
  }

  async getNormalizedPowerSamples(
    days: number,
    userId: string,
    timezone: string,
  ): Promise<NormalizedPowerSampleRow[]> {
    const result = await this.#client.query<NormalizedPowerSampleRow>({
      query: `
        WITH activity_info AS (
          SELECT
            deduped_samples.activity_id AS activity_id,
            toString(toDate(toTimeZone(activity.started_at, {timezone:String}))) AS activity_date,
            activity.name AS activity_name,
            greatest(
              toInt32(round(
                dateDiff('second', min(deduped_samples.recorded_at), max(deduped_samples.recorded_at))
                / nullIf(count() - 1, 0)
              )),
              1
            ) AS interval_s
          FROM analytics.deduped_sensor AS deduped_samples
          INNER JOIN postgres_fitness_live.v_activity AS activity
            ON activity.id = deduped_samples.activity_id
          WHERE deduped_samples.user_id = {userId:UUID}
            AND deduped_samples.channel = 'power'
            AND deduped_samples.scalar > 0
            AND activity.started_at > now() - toIntervalDay({days:UInt32})
            AND has({enduranceActivityTypes:Array(String)}, activity.activity_type)
          GROUP BY deduped_samples.activity_id, activity.started_at, activity.name
          HAVING count() >= 240
        )
        SELECT
          toString(deduped_samples.activity_id) AS activity_id,
          activity_info.activity_date AS activity_date,
          activity_info.activity_name AS activity_name,
          deduped_samples.scalar AS power,
          activity_info.interval_s AS interval_s
        FROM analytics.deduped_sensor AS deduped_samples
        INNER JOIN activity_info
          ON activity_info.activity_id = deduped_samples.activity_id
        WHERE deduped_samples.channel = 'power'
          AND deduped_samples.scalar > 0
        ORDER BY deduped_samples.activity_id, deduped_samples.recorded_at
      `,
      format: "JSONEachRow",
      query_params: userWindowParams(days, userId, timezone),
    });
    return result.json();
  }

  async getHeartRateCurveRows(
    days: number,
    userId: string,
    timezone: string,
  ): Promise<Array<{ duration_seconds: number; best_hr: number; activity_date: string }>> {
    const result = await this.#client.query<{
      duration_seconds: number;
      best_hr: number;
      activity_date: string;
    }>({
      query: `
        WITH activity_samples AS (
          SELECT
            deduped_samples.activity_id AS activity_id,
            deduped_samples.recorded_at AS recorded_at,
            deduped_samples.scalar AS heart_rate,
            toString(toDate(toTimeZone(activity.started_at, {timezone:String}))) AS activity_date,
            row_number() OVER (
              PARTITION BY deduped_samples.activity_id
              ORDER BY deduped_samples.recorded_at
            ) AS row_number,
            sum(deduped_samples.scalar) OVER (
              PARTITION BY deduped_samples.activity_id
              ORDER BY deduped_samples.recorded_at
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS cumulative_sum
          FROM analytics.deduped_sensor AS deduped_samples
          INNER JOIN postgres_fitness_live.v_activity AS activity
            ON activity.id = deduped_samples.activity_id
          WHERE deduped_samples.user_id = {userId:UUID}
            AND deduped_samples.channel = 'heart_rate'
            AND deduped_samples.scalar > 0
            AND activity.started_at > now() - toIntervalDay({days:UInt32})
            AND has({enduranceActivityTypes:Array(String)}, activity.activity_type)
        ),
        sample_rate AS (
          SELECT
            activity_id,
            greatest(
              toInt32(round(
                dateDiff('second', min(recorded_at), max(recorded_at))
                / nullIf(count() - 1, 0)
              )),
              1
            ) AS interval_s
          FROM activity_samples
          GROUP BY activity_id
          HAVING count() > 1
        ),
        duration_values AS (
          SELECT arrayJoin([5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200]) AS duration_s
        ),
        duration_windows AS (
          SELECT
            duration_values.duration_s AS duration_seconds,
            greatest(1, toInt32(round(duration_values.duration_s / sample_rate.interval_s))) AS window_samples,
            (
              activity_samples.cumulative_sum - ifNull(previous_sample.cumulative_sum, 0)
            ) / toFloat64(window_samples) AS average_heart_rate,
            activity_samples.activity_date AS activity_date
          FROM duration_values
          CROSS JOIN activity_samples
          INNER JOIN sample_rate
            ON sample_rate.activity_id = activity_samples.activity_id
          LEFT JOIN activity_samples AS previous_sample
            ON previous_sample.activity_id = activity_samples.activity_id
           AND previous_sample.row_number = activity_samples.row_number - window_samples
          WHERE activity_samples.row_number >= window_samples
        )
        SELECT
          duration_seconds,
          toInt32(max(average_heart_rate)) AS best_hr,
          argMax(activity_date, average_heart_rate) AS activity_date
        FROM duration_windows
        GROUP BY duration_seconds
        HAVING best_hr > 0
        ORDER BY duration_seconds
      `,
      format: "JSONEachRow",
      query_params: userWindowParams(days, userId, timezone),
    });
    return result.json();
  }

  async getPaceCurveRows(
    days: number,
    userId: string,
    timezone: string,
  ): Promise<Array<{ duration_seconds: number; best_pace: number; activity_date: string }>> {
    const result = await this.#client.query<{
      duration_seconds: number;
      best_pace: number;
      activity_date: string;
    }>({
      query: `
        WITH activity_samples AS (
          SELECT
            deduped_samples.activity_id AS activity_id,
            deduped_samples.recorded_at AS recorded_at,
            deduped_samples.scalar AS speed,
            toString(toDate(toTimeZone(activity.started_at, {timezone:String}))) AS activity_date,
            row_number() OVER (
              PARTITION BY deduped_samples.activity_id
              ORDER BY deduped_samples.recorded_at
            ) AS row_number,
            sum(deduped_samples.scalar) OVER (
              PARTITION BY deduped_samples.activity_id
              ORDER BY deduped_samples.recorded_at
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS cumulative_sum
          FROM analytics.deduped_sensor AS deduped_samples
          INNER JOIN postgres_fitness_live.v_activity AS activity
            ON activity.id = deduped_samples.activity_id
          WHERE deduped_samples.user_id = {userId:UUID}
            AND deduped_samples.channel = 'speed'
            AND deduped_samples.scalar > 0
            AND activity.started_at > now() - toIntervalDay({days:UInt32})
            AND has({enduranceActivityTypes:Array(String)}, activity.activity_type)
        ),
        sample_rate AS (
          SELECT
            activity_id,
            greatest(
              toInt32(round(
                dateDiff('second', min(recorded_at), max(recorded_at))
                / nullIf(count() - 1, 0)
              )),
              1
            ) AS interval_s
          FROM activity_samples
          GROUP BY activity_id
          HAVING count() > 1
        ),
        duration_values AS (
          SELECT arrayJoin([5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200]) AS duration_s
        ),
        duration_windows AS (
          SELECT
            duration_values.duration_s AS duration_seconds,
            greatest(1, toInt32(round(duration_values.duration_s / sample_rate.interval_s))) AS window_samples,
            (
              activity_samples.cumulative_sum - ifNull(previous_sample.cumulative_sum, 0)
            ) / toFloat64(window_samples) AS average_speed,
            activity_samples.activity_date AS activity_date
          FROM duration_values
          CROSS JOIN activity_samples
          INNER JOIN sample_rate
            ON sample_rate.activity_id = activity_samples.activity_id
          LEFT JOIN activity_samples AS previous_sample
            ON previous_sample.activity_id = activity_samples.activity_id
           AND previous_sample.row_number = activity_samples.row_number - window_samples
          WHERE activity_samples.row_number >= window_samples
        ),
        best_per_duration AS (
          SELECT
            duration_seconds,
            max(average_speed) AS best_speed,
            argMax(activity_date, average_speed) AS activity_date
          FROM duration_windows
          GROUP BY duration_seconds
        )
        SELECT
          duration_seconds,
          round(1000.0 / nullIf(best_speed, 0), 1) AS best_pace,
          activity_date
        FROM best_per_duration
        WHERE best_speed > 0
        ORDER BY duration_seconds
      `,
      format: "JSONEachRow",
      query_params: userWindowParams(days, userId, timezone),
    });
    return result.json();
  }

  async getStream(window: ActivitySensorWindow, maxPoints: number): Promise<StreamPointRow[]> {
    const result = await this.#client.query<StreamPointRow>({
      query: `
        ${dedupedSamplesSql(
          "channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude', 'lat', 'lng')",
        )}
        SELECT
          toString(recorded_at) AS recorded_at,
          heart_rate,
          power,
          speed,
          cadence,
          altitude,
          lat,
          lng
        FROM (
          SELECT
            *,
            row_number() OVER (ORDER BY recorded_at) AS row_number,
            count() OVER () AS total
          FROM (
            SELECT
              recorded_at,
              maxIf(scalar, channel = 'heart_rate') AS heart_rate,
              maxIf(scalar, channel = 'power') AS power,
              maxIf(scalar, channel = 'speed') AS speed,
              maxIf(scalar, channel = 'cadence') AS cadence,
              maxIf(scalar, channel = 'altitude') AS altitude,
              maxIf(scalar, channel = 'lat') AS lat,
              maxIf(scalar, channel = 'lng') AS lng
            FROM deduped_samples
            GROUP BY recorded_at
          )
        )
        WHERE row_number % greatest(1, intDiv(total, {maxPoints:UInt32})) = 0
        ORDER BY recorded_at
      `,
      format: "JSONEachRow",
      query_params: queryParams(window, { maxPoints }),
    });
    const rows = await result.json();
    return rows.map((row) => ({
      ...row,
      recorded_at: normalizeClickHouseTimestamp(row.recorded_at),
    }));
  }

  async getHeartRateZoneSeconds(
    window: ActivitySensorWindow,
    maxHr: number,
    restingHr: number,
  ): Promise<HeartRateZoneSecondRow[]> {
    const result = await this.#client.query<HeartRateZoneSecondRow>({
      query: `
        ${dedupedSamplesSql("channel = 'heart_rate'")}
        SELECT
          zone,
          countIf(
            CASE zone
              WHEN 1 THEN scalar >= {restingHr:Float64} + ({maxHr:Float64} - {restingHr:Float64}) * 0.5
                AND scalar < {restingHr:Float64} + ({maxHr:Float64} - {restingHr:Float64}) * 0.6
              WHEN 2 THEN scalar >= {restingHr:Float64} + ({maxHr:Float64} - {restingHr:Float64}) * 0.6
                AND scalar < {restingHr:Float64} + ({maxHr:Float64} - {restingHr:Float64}) * 0.7
              WHEN 3 THEN scalar >= {restingHr:Float64} + ({maxHr:Float64} - {restingHr:Float64}) * 0.7
                AND scalar < {restingHr:Float64} + ({maxHr:Float64} - {restingHr:Float64}) * 0.8
              WHEN 4 THEN scalar >= {restingHr:Float64} + ({maxHr:Float64} - {restingHr:Float64}) * 0.8
                AND scalar < {restingHr:Float64} + ({maxHr:Float64} - {restingHr:Float64}) * 0.9
              WHEN 5 THEN scalar >= {restingHr:Float64} + ({maxHr:Float64} - {restingHr:Float64}) * 0.9
              ELSE false
            END
          ) AS seconds
        FROM (SELECT number + 1 AS zone FROM numbers(5)) AS zones
        LEFT JOIN (SELECT scalar FROM deduped_samples) AS heart_rate_samples ON true
        GROUP BY zone
        ORDER BY zone
      `,
      format: "JSONEachRow",
      query_params: queryParams(window, { maxHr, restingHr }),
    });
    return result.json();
  }

  async getPowerZoneSeconds(
    window: ActivitySensorWindow,
    ftp: number,
  ): Promise<PowerZoneSecondRow[]> {
    const result = await this.#client.query<PowerZoneSecondRow>({
      query: `
        ${dedupedSamplesSql("channel = 'power'")}
        SELECT
          zone,
          countIf(
            CASE zone
              WHEN 1 THEN scalar < {ftp:Float64} * 0.55
              WHEN 2 THEN scalar >= {ftp:Float64} * 0.55 AND scalar < {ftp:Float64} * 0.75
              WHEN 3 THEN scalar >= {ftp:Float64} * 0.75 AND scalar < {ftp:Float64} * 0.9
              WHEN 4 THEN scalar >= {ftp:Float64} * 0.9 AND scalar < {ftp:Float64} * 1.05
              WHEN 5 THEN scalar >= {ftp:Float64} * 1.05 AND scalar < {ftp:Float64} * 1.2
              WHEN 6 THEN scalar >= {ftp:Float64} * 1.2 AND scalar < {ftp:Float64} * 1.5
              WHEN 7 THEN scalar >= {ftp:Float64} * 1.5
              ELSE false
            END
          ) AS seconds
        FROM (SELECT number + 1 AS zone FROM numbers(7)) AS zones
        LEFT JOIN (SELECT scalar FROM deduped_samples) AS power_samples ON true
        GROUP BY zone
        ORDER BY zone
      `,
      format: "JSONEachRow",
      query_params: queryParams(window, { ftp }),
    });
    return result.json();
  }
}
