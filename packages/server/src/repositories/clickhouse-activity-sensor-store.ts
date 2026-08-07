import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import type { ClickHouseCommandClient } from "dofek/db/clickhouse";
import { refreshBodyMeasurementReadModel } from "dofek/db/clickhouse-read-model-refresh";
import { z } from "zod";
import {
  clickHouseToIntervalDayLowerBound,
  type RangeDays,
  rangeDaysParams,
} from "../lib/date-window.ts";
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

function userWindowParams(days: RangeDays, userId: string, timezone: string) {
  return {
    ...rangeDaysParams(days),
    userId,
    timezone,
    enduranceActivityTypes: [...ENDURANCE_ACTIVITY_TYPES],
  };
}

function normalizeClickHouseTimestamp(value: string): string {
  const timestamp = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  return new Date(timestamp).toISOString();
}

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

const heartRateZoneSecondRowSchema = z.object({
  zone: z.coerce.number(),
  seconds: z.coerce.number(),
});

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
    days: number | null,
    userId: string,
    timezone: string,
    activityTypes: readonly string[],
  ): Promise<PowerCurveSampleRow[]> {
    return getClickHousePowerCurveSamples(this.#client, days, userId, timezone, activityTypes);
  }

  async getNormalizedPowerSamples(
    days: number | null,
    userId: string,
    timezone: string,
    activityTypes: readonly string[],
  ): Promise<NormalizedPowerSampleRow[]> {
    return getClickHouseNormalizedPowerSamples(this.#client, days, userId, timezone, activityTypes);
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
    days: RangeDays,
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
            ${clickHouseToIntervalDayLowerBound(days, "activity.started_at")}
            AND activity.is_deleted = 0
            AND has({enduranceActivityTypes:Array(String)}, activity.canonical_type)
        ),
        sample_rate AS (
          SELECT
            activity_id,
            greatest(
              toInt32(round(
                dateDiff('second', min(recorded_at), max(recorded_at))
                / greatest(count() - 1, 1)
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
    days: RangeDays,
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
            ${clickHouseToIntervalDayLowerBound(days, "activity.started_at")}
            AND activity.is_deleted = 0
            AND has({enduranceActivityTypes:Array(String)}, activity.canonical_type)
        ),
        sample_rate AS (
          SELECT
            activity_id,
            greatest(
              toInt32(round(
                dateDiff('second', min(recorded_at), max(recorded_at))
                / greatest(count() - 1, 1)
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
    const result = await this.#client.query<Record<string, unknown>>({
      query: `
        WITH expanded_points AS (
          SELECT
            point.1 AS recorded_at,
            point.2 AS heart_rate,
            point.3 AS power,
            point.4 AS speed,
            point.5 AS cadence,
            point.6 AS altitude,
            point.7 AS lat,
            point.8 AS lng
          FROM analytics.activity_stream_points FINAL
          ARRAY JOIN points AS point
          WHERE user_id = {userId:UUID}
            AND activity_id IN {activityIds:Array(UUID)}
            AND is_deleted = 0
            AND point.1 >= parseDateTime64BestEffort({windowStartedAt:String})
            AND point.1 <= parseDateTime64BestEffort({windowEndedAt:String})
        ),
        grouped_point_tuples AS (
          SELECT
            recorded_at,
            any(tuple(heart_rate, power, speed, cadence, altitude, lat, lng)) AS point_values
          FROM expanded_points
          GROUP BY recorded_at
        ),
        grouped_points AS (
          SELECT
            recorded_at,
            point_values.1 AS heart_rate,
            point_values.2 AS power,
            point_values.3 AS speed,
            point_values.4 AS cadence,
            point_values.5 AS altitude,
            point_values.6 AS lat,
            point_values.7 AS lng
          FROM grouped_point_tuples
        ),
        ranked_points AS (
          SELECT
            recorded_at,
            heart_rate,
            power,
            speed,
            cadence,
            altitude,
            lat,
            lng,
            row_number() OVER (ORDER BY recorded_at) AS point_index,
            count() OVER () AS point_count
          FROM grouped_points
        ),
        selected_points AS (
          SELECT
            recorded_at AS sample_recorded_at,
            heart_rate,
            power,
            speed,
            cadence,
            altitude,
            lat AS sample_lat,
            lng AS sample_lng,
            if(
              point_count <= toUInt64({maxPoints:UInt32}),
              point_index - 1,
              intDiv(
                (point_index - 1) * (toUInt64({maxPoints:UInt32}) - 1),
                greatest(point_count - 1, 1)
              )
            ) AS sample_bucket
          FROM ranked_points
        ),
        downsampled_points AS (
          SELECT
            sample_bucket,
            min(sample_recorded_at) AS recorded_at,
            if(
              countIf(heart_rate IS NOT NULL) = 0,
              NULL,
              argMinIf(heart_rate, sample_recorded_at, heart_rate IS NOT NULL)
            ) AS heart_rate,
            if(
              countIf(power IS NOT NULL) = 0,
              NULL,
              argMinIf(power, sample_recorded_at, power IS NOT NULL)
            ) AS power,
            if(
              countIf(speed IS NOT NULL) = 0,
              NULL,
              argMinIf(speed, sample_recorded_at, speed IS NOT NULL)
            ) AS speed,
            if(
              countIf(cadence IS NOT NULL) = 0,
              NULL,
              argMinIf(cadence, sample_recorded_at, cadence IS NOT NULL)
            ) AS cadence,
            if(
              countIf(altitude IS NOT NULL) = 0,
              NULL,
              argMinIf(altitude, sample_recorded_at, altitude IS NOT NULL)
            ) AS altitude,
            if(
              countIf(sample_lat IS NOT NULL AND sample_lng IS NOT NULL) = 0,
              NULL,
              argMinIf(
                sample_lat,
                sample_recorded_at,
                sample_lat IS NOT NULL AND sample_lng IS NOT NULL
              )
            ) AS lat,
            if(
              countIf(sample_lat IS NOT NULL AND sample_lng IS NOT NULL) = 0,
              NULL,
              argMinIf(
                sample_lng,
                sample_recorded_at,
                sample_lat IS NOT NULL AND sample_lng IS NOT NULL
              )
            ) AS lng
          FROM selected_points
          GROUP BY sample_bucket
        )
        SELECT
          toString(recorded_at) AS recorded_at,
          heart_rate,
          power,
          speed,
          cadence,
          altitude,
          lat,
          lng
        FROM downsampled_points
        ORDER BY recorded_at
      `,
      format: "JSONEachRow",
      query_params: queryParams(window, { maxPoints }),
    });
    const rows = await result.json();
    return rows.map((row) => {
      const parsedRow = streamPointRowSchema.parse(row);
      return {
        ...parsedRow,
        recorded_at: normalizeClickHouseTimestamp(parsedRow.recorded_at),
      };
    });
  }

  async getHeartRateZoneSeconds(window: ActivitySensorWindow): Promise<HeartRateZoneSecondRow[]> {
    const result = await this.#client.query<Record<string, unknown>>({
      query: `
        SELECT
          zone_tuple.1 AS zone,
          sum(zone_tuple.2) AS seconds
        FROM analytics.activity_heart_rate_zones FINAL
        ARRAY JOIN zones AS zone_tuple
        WHERE user_id = {userId:UUID}
          AND activity_id IN {activityIds:Array(UUID)}
          AND is_deleted = 0
        GROUP BY zone_tuple.1
        ORDER BY zone_tuple.1
      `,
      format: "JSONEachRow",
      query_params: queryParams(window, {}),
    });
    const rows = await result.json();
    return rows.map((row) => heartRateZoneSecondRowSchema.parse(row));
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
