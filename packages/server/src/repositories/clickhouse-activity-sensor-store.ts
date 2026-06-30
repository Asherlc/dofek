import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import type { ClickHouseCommandClient } from "dofek/db/clickhouse";
import { refreshBodyMeasurementReadModel } from "dofek/db/clickhouse-read-model-refresh";
import type { z } from "zod";
import type {
  ActivitySensorQueryOptions,
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
import {
  heartRateZoneCaseSql,
  heartRateZoneNumbersSql,
  heartRateZoneSqlParams,
} from "./heart-rate-zone-sql.ts";

interface ClickHouseActivitySensorClient
  extends ClickHouseQueryClient,
    Pick<ClickHouseCommandClient, "command"> {}

const maxActivityWindowMs = 12 * 60 * 60 * 1000;

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
  centroid_lat: number | null;
  centroid_lng: number | null;
}

function maxActivityWindowEndedAt(startedAt: string): string {
  return new Date(new Date(startedAt).getTime() + maxActivityWindowMs).toISOString();
}

function queryParams(window: ActivitySensorWindow, extra: Record<string, unknown>) {
  return {
    activityIds: [...new Set([window.activityId, ...window.memberActivityIds])],
    windowStartedAt: window.startedAt,
    windowEndedAt: window.endedAt ?? maxActivityWindowEndedAt(window.startedAt),
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
        AND recorded_at >= parseDateTime64BestEffort({windowStartedAt:String})
        AND recorded_at <= parseDateTime64BestEffort({windowEndedAt:String})
        AND is_deleted = 0
        AND ${channelPredicate}
    )
  `;
}

function activityStreamSamplesSql(channelPredicate = "1 = 1"): string {
  return `
    WITH activity_samples AS (
      SELECT
        recorded_at,
        channel,
        scalar
      FROM analytics.activity_sensor_sample
      WHERE user_id = {userId:UUID}
        AND activity_id IN {activityIds:Array(UUID)}
        AND recorded_at >= parseDateTime64BestEffort({windowStartedAt:String})
        AND recorded_at <= parseDateTime64BestEffort({windowEndedAt:String})
        AND is_deleted = 0
        AND ${channelPredicate}
    )
  `;
}

export class ClickHouseActivitySensorStore implements ActivitySensorStore {
  readonly #client: ClickHouseActivitySensorClient;

  constructor(client: ClickHouseActivitySensorClient) {
    this.#client = client;
  }

  async query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params: Record<string, unknown> = {},
    options: ActivitySensorQueryOptions = {},
  ): Promise<z.infer<TSchema>[]> {
    const result = await this.#client.query<Record<string, unknown>>({
      query,
      format: "JSONEachRow",
      query_params: params,
      ...(options.abortSignal ? { abort_signal: options.abortSignal } : {}),
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
          sample_count,
          centroid_lat,
          centroid_lng
        FROM analytics.activity_summary asum
        WHERE asum.activity_id IN (
          SELECT arrayJoin(CAST({activityIds:Array(String)}, 'Array(UUID)'))
        )
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
            activity.activity_id AS activity_id,
            deduped_samples.recorded_at AS recorded_at,
            deduped_samples.scalar AS heart_rate,
            toString(toDate(toTimeZone(activity.started_at, {timezone:String}))) AS activity_date,
            row_number() OVER (
              PARTITION BY activity.activity_id
              ORDER BY deduped_samples.recorded_at
            ) AS row_number,
            sum(deduped_samples.scalar) OVER (
              PARTITION BY activity.activity_id
              ORDER BY deduped_samples.recorded_at
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS cumulative_sum
          FROM analytics.deduped_sensor AS deduped_samples
          INNER JOIN analytics.deduped_activities AS activity FINAL
            ON activity.user_id = deduped_samples.user_id
          WHERE deduped_samples.user_id = {userId:UUID}
            AND deduped_samples.channel = 'heart_rate'
            AND deduped_samples.scalar > 0
            AND deduped_samples.is_deleted = 0
            AND deduped_samples.recorded_at >= activity.started_at
            AND deduped_samples.recorded_at <= coalesce(activity.ended_at, activity.started_at + INTERVAL 12 HOUR)
            AND activity.started_at > now() - toIntervalDay({days:UInt32})
            AND activity.is_deleted = 0
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
            activity.activity_id AS activity_id,
            deduped_samples.recorded_at AS recorded_at,
            deduped_samples.scalar AS speed,
            toString(toDate(toTimeZone(activity.started_at, {timezone:String}))) AS activity_date,
            row_number() OVER (
              PARTITION BY activity.activity_id
              ORDER BY deduped_samples.recorded_at
            ) AS row_number,
            sum(deduped_samples.scalar) OVER (
              PARTITION BY activity.activity_id
              ORDER BY deduped_samples.recorded_at
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS cumulative_sum
          FROM analytics.deduped_sensor AS deduped_samples
          INNER JOIN analytics.deduped_activities AS activity FINAL
            ON activity.user_id = deduped_samples.user_id
          WHERE deduped_samples.user_id = {userId:UUID}
            AND deduped_samples.channel = 'speed'
            AND deduped_samples.scalar > 0
            AND deduped_samples.is_deleted = 0
            AND deduped_samples.recorded_at >= activity.started_at
            AND deduped_samples.recorded_at <= coalesce(activity.ended_at, activity.started_at + INTERVAL 12 HOUR)
            AND activity.started_at > now() - toIntervalDay({days:UInt32})
            AND activity.is_deleted = 0
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
        ${activityStreamSamplesSql("channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude')")}
        , location_samples AS (
          SELECT recorded_at, lat, lng
          FROM analytics.activity_location_sample
          WHERE user_id = {userId:UUID}
            AND activity_id IN {activityIds:Array(UUID)}
            AND recorded_at >= parseDateTime64BestEffort({windowStartedAt:String})
            AND recorded_at <= parseDateTime64BestEffort({windowEndedAt:String})
            AND is_deleted = 0
        ),
        combined_sample_times AS (
          SELECT recorded_at, 0 AS has_location FROM activity_samples
          UNION ALL
          SELECT recorded_at, 1 AS has_location FROM location_samples
        ),
        deduped_sample_times AS (
          SELECT
            recorded_at,
            max(has_location) AS has_location
          FROM combined_sample_times
          GROUP BY recorded_at
        ),
        ranked_sample_times AS (
          SELECT
            recorded_at,
            has_location,
            row_number() OVER (ORDER BY recorded_at) AS row_number,
            count() OVER () AS total
          FROM deduped_sample_times
        ),
        bucketed_sample_times AS (
          SELECT
            recorded_at,
            has_location,
            total,
            intDiv(
              (row_number - 1) * (toUInt64({maxPoints:UInt32}) - 1),
              greatest(total - 1, 1)
            ) AS sample_bucket
          FROM ranked_sample_times
        ),
        sample_times AS (
          SELECT recorded_at
          FROM bucketed_sample_times
          WHERE total <= toUInt64({maxPoints:UInt32})
          UNION DISTINCT
          SELECT
            if(
              sample_bucket = 0,
              min(recorded_at),
              if(
                sample_bucket = toUInt64({maxPoints:UInt32}) - 1,
                max(recorded_at),
                if(
                  countIf(has_location = 1) > 0,
                  argMinIf(recorded_at, recorded_at, has_location = 1),
                  min(recorded_at)
                )
              )
            ) AS recorded_at
          FROM bucketed_sample_times
          WHERE total > toUInt64({maxPoints:UInt32})
          GROUP BY sample_bucket
        ),
        selected_scalar_points AS (
          SELECT
            sample_times.recorded_at AS recorded_at,
            maxIf(activity_samples.scalar, activity_samples.channel = 'heart_rate') AS heart_rate,
            maxIf(activity_samples.scalar, activity_samples.channel = 'power') AS power,
            maxIf(activity_samples.scalar, activity_samples.channel = 'speed') AS speed,
            maxIf(activity_samples.scalar, activity_samples.channel = 'cadence') AS cadence,
            maxIf(activity_samples.scalar, activity_samples.channel = 'altitude') AS altitude
          FROM sample_times
          LEFT JOIN activity_samples
            ON activity_samples.recorded_at = sample_times.recorded_at
          GROUP BY sample_times.recorded_at
        )
        SELECT
          toString(sample_times.recorded_at) AS recorded_at,
          selected_scalar_points.heart_rate AS heart_rate,
          selected_scalar_points.power AS power,
          selected_scalar_points.speed AS speed,
          selected_scalar_points.cadence AS cadence,
          selected_scalar_points.altitude AS altitude,
          location_samples.lat AS lat,
          location_samples.lng AS lng
        FROM (
          SELECT
            sample_times.recorded_at AS recorded_at
          FROM sample_times
        ) AS sample_times
        LEFT JOIN selected_scalar_points
          ON selected_scalar_points.recorded_at = sample_times.recorded_at
        LEFT JOIN location_samples
          ON location_samples.recorded_at = sample_times.recorded_at
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
              ${heartRateZoneCaseSql("scalar")}
              ELSE false
            END
          ) AS seconds
        FROM (${heartRateZoneNumbersSql()}) AS zones
        LEFT JOIN (SELECT scalar FROM deduped_samples) AS heart_rate_samples ON true
        GROUP BY zone
        ORDER BY zone
      `,
      format: "JSONEachRow",
      query_params: queryParams(window, { maxHr, restingHr, ...heartRateZoneSqlParams() }),
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

  async refreshBodyMeasurements(): Promise<void> {
    await refreshBodyMeasurementReadModel(this.#client);
  }
}
