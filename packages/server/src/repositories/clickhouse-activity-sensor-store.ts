import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import type { z } from "zod";
import type {
  ActivitySensorStore,
  ActivitySensorWindow,
  StreamPointRow,
} from "./activity-repository.ts";
import {
  getClickHouseNormalizedPowerSamples,
  getClickHousePowerCurveSamples,
  getClickHouseVo2MaxEstimates,
} from "./clickhouse-activity-sensor-analytics.ts";
import type {
  ClickHouseQueryClient,
  HeartRateZoneSecondRow,
  NormalizedPowerSampleRow,
  PowerCurveSampleRow,
  PowerZoneSecondRow,
  Vo2MaxEstimateRow,
} from "./clickhouse-activity-sensor-types.ts";

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

  async query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params: Record<string, unknown> = {},
  ): Promise<z.infer<TSchema>[]> {
    const result = await this.#client.query<Record<string, unknown>>({
      query,
      format: "JSONEachRow",
      query_params: params,
    });
    const rows = await result.json();
    return rows.map((row) => schema.parse(row));
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
        WHERE toString(activity_id) IN {activityIds:Array(String)}
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
    return getClickHousePowerCurveSamples(this.#client, days, userId, timezone);
  }

  async getNormalizedPowerSamples(
    days: number,
    userId: string,
    timezone: string,
  ): Promise<NormalizedPowerSampleRow[]> {
    return getClickHouseNormalizedPowerSamples(this.#client, days, userId, timezone);
  }

  async getVo2MaxEstimates(
    endDate: string,
    days: number,
    userId: string,
    timezone: string,
  ): Promise<Vo2MaxEstimateRow[]> {
    return getClickHouseVo2MaxEstimates(this.#client, endDate, days, userId, timezone);
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
          INNER JOIN analytics.v_activity AS activity
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
           AND toInt64(previous_sample.row_number) = toInt64(activity_samples.row_number) - toInt64(window_samples)
          WHERE toInt64(activity_samples.row_number) >= toInt64(window_samples)
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
          INNER JOIN analytics.v_activity AS activity
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
           AND toInt64(previous_sample.row_number) = toInt64(activity_samples.row_number) - toInt64(window_samples)
          WHERE toInt64(activity_samples.row_number) >= toInt64(window_samples)
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
        ${dedupedSamplesSql("channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude')")}
        , location_samples AS (
          SELECT recorded_at, lat, lng
          FROM analytics.deduped_location
          WHERE user_id = {userId:UUID}
            AND activity_id = {activityId:UUID}
        ),
        sample_times AS (
          SELECT recorded_at FROM deduped_samples
          UNION DISTINCT
          SELECT recorded_at FROM location_samples
        ),
        scalar_points AS (
          SELECT
            recorded_at,
            maxIf(scalar, channel = 'heart_rate') AS heart_rate,
            maxIf(scalar, channel = 'power') AS power,
            maxIf(scalar, channel = 'speed') AS speed,
            maxIf(scalar, channel = 'cadence') AS cadence,
            maxIf(scalar, channel = 'altitude') AS altitude
          FROM deduped_samples
          GROUP BY recorded_at
        )
        SELECT
          toString(sample_times.recorded_at) AS recorded_at,
          scalar_points.heart_rate AS heart_rate,
          scalar_points.power AS power,
          scalar_points.speed AS speed,
          scalar_points.cadence AS cadence,
          scalar_points.altitude AS altitude,
          location_samples.lat AS lat,
          location_samples.lng AS lng
        FROM (
          SELECT
            sample_times.recorded_at AS recorded_at,
            row_number() OVER (ORDER BY sample_times.recorded_at) AS row_number,
            count() OVER () AS total
          FROM sample_times
        ) AS sample_times
        LEFT JOIN scalar_points
          ON scalar_points.recorded_at = sample_times.recorded_at
        LEFT JOIN location_samples
          ON location_samples.recorded_at = sample_times.recorded_at
        WHERE row_number % greatest(1, intDiv(total, {maxPoints:UInt32})) = 0
        ORDER BY sample_times.recorded_at
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
