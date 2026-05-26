import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import type {
  ClickHouseQueryClient,
  NormalizedPowerSampleRow,
  PowerCurveSampleRow,
  Vo2MaxEstimateRow,
} from "./clickhouse-activity-sensor-types.ts";

function userWindowParams(days: number, userId: string, timezone: string) {
  return {
    days,
    userId,
    timezone,
    enduranceActivityTypes: [...ENDURANCE_ACTIVITY_TYPES],
  };
}

function userDateWindowParams(endDate: string, days: number, userId: string, timezone: string) {
  return {
    endDate,
    days,
    userId,
    timezone,
  };
}

export async function getClickHousePowerCurveSamples(
  client: ClickHouseQueryClient,
  days: number,
  userId: string,
  timezone: string,
): Promise<PowerCurveSampleRow[]> {
  const result = await client.query<PowerCurveSampleRow>({
    query: `
        WITH activity_info AS (
          SELECT
            activity.activity_id AS activity_id,
            activity.user_id AS user_id,
            activity.started_at AS started_at,
            activity.ended_at AS ended_at,
            toString(toDate(toTimeZone(activity.started_at, {timezone:String}))) AS activity_date,
            greatest(
              toInt32(round(
                dateDiff('second', min(deduped_samples.recorded_at), max(deduped_samples.recorded_at))
                / nullIf(count() - 1, 0)
              )),
              1
            ) AS interval_s
          FROM analytics.deduped_sensor AS deduped_samples
          INNER JOIN analytics.activity_summary AS activity
            ON activity.user_id = deduped_samples.user_id
           AND deduped_samples.recorded_at >= activity.started_at
           AND deduped_samples.recorded_at <= coalesce(activity.ended_at, activity.started_at + INTERVAL 12 HOUR)
          WHERE deduped_samples.user_id = {userId:UUID}
            AND deduped_samples.channel = 'power'
            AND deduped_samples.is_deleted = 0
            AND activity.started_at > now() - toIntervalDay({days:UInt32})
            AND has({enduranceActivityTypes:Array(String)}, activity.activity_type)
          GROUP BY activity.activity_id, activity.user_id, activity.started_at, activity.ended_at
          HAVING count() > 1
        )
        SELECT
          toString(activity_info.activity_id) AS activity_id,
          activity_info.activity_date AS activity_date,
          ifNull(deduped_samples.scalar, 0) AS power,
          activity_info.interval_s AS interval_s
        FROM analytics.deduped_sensor AS deduped_samples
        INNER JOIN activity_info
          ON activity_info.user_id = deduped_samples.user_id
         AND deduped_samples.recorded_at >= activity_info.started_at
         AND deduped_samples.recorded_at <= coalesce(activity_info.ended_at, activity_info.started_at + INTERVAL 12 HOUR)
        WHERE deduped_samples.channel = 'power'
          AND deduped_samples.is_deleted = 0
        ORDER BY activity_info.activity_id, deduped_samples.recorded_at
      `,
    format: "JSONEachRow",
    query_params: userWindowParams(days, userId, timezone),
  });
  return result.json();
}

export async function getClickHouseNormalizedPowerSamples(
  client: ClickHouseQueryClient,
  days: number,
  userId: string,
  timezone: string,
): Promise<NormalizedPowerSampleRow[]> {
  const result = await client.query<NormalizedPowerSampleRow>({
    query: `
        WITH activity_info AS (
          SELECT
            activity.activity_id AS activity_id,
            activity.user_id AS user_id,
            activity.started_at AS started_at,
            activity.ended_at AS ended_at,
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
          INNER JOIN analytics.activity_summary AS activity
            ON activity.user_id = deduped_samples.user_id
           AND deduped_samples.recorded_at >= activity.started_at
           AND deduped_samples.recorded_at <= coalesce(activity.ended_at, activity.started_at + INTERVAL 12 HOUR)
          WHERE deduped_samples.user_id = {userId:UUID}
            AND deduped_samples.channel = 'power'
            AND deduped_samples.scalar > 0
            AND deduped_samples.is_deleted = 0
            AND activity.started_at > now() - toIntervalDay({days:UInt32})
            AND has({enduranceActivityTypes:Array(String)}, activity.activity_type)
          GROUP BY activity.activity_id, activity.user_id, activity.started_at, activity.ended_at, activity.name
          HAVING count() >= 240
        )
        SELECT
          toString(activity_info.activity_id) AS activity_id,
          activity_info.activity_date AS activity_date,
          activity_info.activity_name AS activity_name,
          deduped_samples.scalar AS power,
          activity_info.interval_s AS interval_s
        FROM analytics.deduped_sensor AS deduped_samples
        INNER JOIN activity_info
          ON activity_info.user_id = deduped_samples.user_id
         AND deduped_samples.recorded_at >= activity_info.started_at
         AND deduped_samples.recorded_at <= coalesce(activity_info.ended_at, activity_info.started_at + INTERVAL 12 HOUR)
        WHERE deduped_samples.channel = 'power'
          AND deduped_samples.scalar > 0
          AND deduped_samples.is_deleted = 0
        ORDER BY activity_info.activity_id, deduped_samples.recorded_at
      `,
    format: "JSONEachRow",
    query_params: userWindowParams(days, userId, timezone),
  });
  return result.json();
}

export async function getClickHouseVo2MaxEstimates(
  client: ClickHouseQueryClient,
  endDate: string,
  days: number,
  userId: string,
  timezone: string,
): Promise<Vo2MaxEstimateRow[]> {
  const result = await client.query<Vo2MaxEstimateRow>({
    query: `
        SELECT
          toString(activity_id) AS activity_id,
          toString(toDate(toTimeZone(started_at, {timezone:String}))) AS activity_date,
          method,
          vo2max
        FROM analytics.activity_vo2max_estimate FINAL
        WHERE user_id = {userId:UUID}
          AND is_deleted = 0
          AND toDate(toTimeZone(started_at, {timezone:String})) > subtractDays(toDate({endDate:String}), {days:UInt32})
          AND toDate(toTimeZone(started_at, {timezone:String})) <= toDate({endDate:String})
          AND vo2max BETWEEN 1 AND 100
        ORDER BY started_at DESC
      `,
    format: "JSONEachRow",
    query_params: userDateWindowParams(endDate, days, userId, timezone),
  });
  return result.json();
}
