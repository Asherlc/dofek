import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import { dateWindowStartString } from "../lib/date-window.ts";
import type {
  ClickHouseQueryClient,
  NormalizedPowerSampleRow,
  PowerCurveSampleRow,
  Vo2MaxEstimateRow,
} from "./clickhouse-activity-sensor-types.ts";
import { restingHeartRateClickHouseCte } from "./resting-heart-rate-query.ts";

const OUTDOOR_VO2_MAX_ACTIVITY_TYPES = ["running", "trail_running", "walking", "hiking"] as const;

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
    rhrEndDate: endDate,
    rhrWindowStart: dateWindowStartString(endDate, days + 60),
    enduranceActivityTypes: [...ENDURANCE_ACTIVITY_TYPES],
    outdoorVo2MaxActivityTypes: [...OUTDOOR_VO2_MAX_ACTIVITY_TYPES],
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
            activity.id AS activity_id,
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
          INNER JOIN analytics.v_activity AS activity
            ON activity.user_id = deduped_samples.user_id
           AND deduped_samples.recorded_at >= activity.started_at
           AND deduped_samples.recorded_at <= coalesce(activity.ended_at, activity.started_at + INTERVAL 12 HOUR)
          WHERE deduped_samples.user_id = {userId:UUID}
            AND deduped_samples.channel = 'power'
            AND deduped_samples.is_deleted = 0
            AND activity.started_at > now() - toIntervalDay({days:UInt32})
            AND has({enduranceActivityTypes:Array(String)}, activity.activity_type)
          GROUP BY activity.id, activity.user_id, activity.started_at, activity.ended_at
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
            activity.id AS activity_id,
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
          INNER JOIN analytics.v_activity AS activity
            ON activity.user_id = deduped_samples.user_id
           AND deduped_samples.recorded_at >= activity.started_at
           AND deduped_samples.recorded_at <= coalesce(activity.ended_at, activity.started_at + INTERVAL 12 HOUR)
          WHERE deduped_samples.user_id = {userId:UUID}
            AND deduped_samples.channel = 'power'
            AND deduped_samples.scalar > 0
            AND deduped_samples.is_deleted = 0
            AND activity.started_at > now() - toIntervalDay({days:UInt32})
            AND has({enduranceActivityTypes:Array(String)}, activity.activity_type)
          GROUP BY activity.id, activity.user_id, activity.started_at, activity.ended_at, activity.name
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
        WITH ${restingHeartRateClickHouseCte()},
        activities AS (
          SELECT
            id,
            user_id,
            activity_type,
            started_at,
            ended_at,
            toString(toDate(toTimeZone(started_at, {timezone:String}))) AS activity_date
          FROM analytics.v_activity
          WHERE user_id = {userId:UUID}
            AND toDate(toTimeZone(started_at, {timezone:String})) > subtractDays(toDate({endDate:String}), {days:UInt32})
            AND toDate(toTimeZone(started_at, {timezone:String})) <= toDate({endDate:String})
            AND has({enduranceActivityTypes:Array(String)}, activity_type)
        ),
        latest_weight AS (
          SELECT weight_kg
          FROM analytics.v_body_measurement
          WHERE user_id = {userId:UUID}
            AND weight_kg IS NOT NULL
          ORDER BY recorded_at DESC
          LIMIT 1
        ),
        power_samples AS (
          SELECT
            activities.id AS activity_id,
            activities.activity_date AS activity_date,
            deduped_samples.recorded_at AS recorded_at,
            deduped_samples.scalar AS power,
            row_number() OVER (
              PARTITION BY activities.id
              ORDER BY deduped_samples.recorded_at
            ) AS row_number,
            sum(deduped_samples.scalar) OVER (
              PARTITION BY activities.id
              ORDER BY deduped_samples.recorded_at
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS cumulative_sum
          FROM analytics.deduped_sensor AS deduped_samples
          INNER JOIN activities
            ON activities.user_id = deduped_samples.user_id
           AND deduped_samples.recorded_at >= activities.started_at
           AND deduped_samples.recorded_at <= coalesce(activities.ended_at, activities.started_at + INTERVAL 12 HOUR)
          WHERE deduped_samples.user_id = {userId:UUID}
            AND deduped_samples.channel = 'power'
            AND deduped_samples.scalar > 0
            AND deduped_samples.is_deleted = 0
        ),
        power_sample_rate AS (
          SELECT
            activity_id,
            greatest(
              toInt32(round(
                dateDiff('second', min(recorded_at), max(recorded_at))
                / nullIf(count() - 1, 0)
              )),
              1
            ) AS interval_s
          FROM power_samples
          GROUP BY activity_id
          HAVING count() >= 240
        ),
        power_windows AS (
          SELECT
            power_samples.activity_id AS activity_id,
            power_samples.activity_date AS activity_date,
            (
              power_samples.cumulative_sum - ifNull(previous_sample.cumulative_sum, 0)
            ) / toFloat64(window_samples) AS five_minute_power_watts
          FROM power_samples
          INNER JOIN (
            SELECT
              activity_id,
              greatest(1, toInt32(round(300 / interval_s))) AS window_samples
            FROM power_sample_rate
          ) AS sample_windows
            ON sample_windows.activity_id = power_samples.activity_id
          LEFT JOIN power_samples AS previous_sample
            ON previous_sample.activity_id = power_samples.activity_id
           AND toInt64(previous_sample.row_number) = toInt64(power_samples.row_number) - toInt64(sample_windows.window_samples)
          WHERE toInt64(power_samples.row_number) >= toInt64(sample_windows.window_samples)
        ),
        cycling_estimates AS (
          SELECT
            toString(activity_id) AS activity_id,
            activity_date,
            'cycling_power' AS method,
            ((max(five_minute_power_watts) / any(latest_weight.weight_kg)) * 10.8 + 7) AS vo2max
          FROM power_windows
          CROSS JOIN latest_weight
          GROUP BY activity_id, activity_date
          HAVING max(five_minute_power_watts) BETWEEN 50 AND 700
            AND vo2max > 0
        ),
        acsm_segments AS (
          SELECT
            activities.id AS activity_id,
            activities.activity_date AS activity_date,
            intDiv(toUInt32(dateDiff('second', activities.started_at, deduped_samples.recorded_at)), 300) AS segment_index,
            avgIf(deduped_samples.scalar * 60, deduped_samples.channel = 'speed') AS speed_meters_per_minute,
            avgIf(deduped_samples.scalar, deduped_samples.channel = 'heart_rate') AS average_heart_rate,
            (maxIf(deduped_samples.scalar, deduped_samples.channel = 'altitude')
              - minIf(deduped_samples.scalar, deduped_samples.channel = 'altitude'))
              / nullIf(avgIf(deduped_samples.scalar, deduped_samples.channel = 'speed') * 300, 0) AS grade_fraction
          FROM analytics.deduped_sensor AS deduped_samples
          INNER JOIN activities
            ON activities.user_id = deduped_samples.user_id
           AND deduped_samples.recorded_at >= activities.started_at
           AND deduped_samples.recorded_at <= coalesce(activities.ended_at, activities.started_at + INTERVAL 12 HOUR)
          WHERE deduped_samples.user_id = {userId:UUID}
            AND has({outdoorVo2MaxActivityTypes:Array(String)}, activities.activity_type)
            AND deduped_samples.channel IN ('speed', 'heart_rate', 'altitude')
            AND deduped_samples.scalar IS NOT NULL
            AND deduped_samples.is_deleted = 0
          GROUP BY activities.id, activities.activity_date, segment_index
          HAVING
            countIf(deduped_samples.channel = 'speed') >= 60
            AND countIf(deduped_samples.channel = 'heart_rate') >= 60
            AND countIf(deduped_samples.channel = 'altitude') >= 2
        ),
        resting_by_activity AS (
          SELECT
            activities.id AS activity_id,
            argMax(resting.resting_hr, resting.date) AS resting_hr
          FROM activities
          CROSS JOIN resting_heart_rate AS resting
          WHERE resting.date <= activities.activity_date
          GROUP BY activities.id
        ),
        acsm_estimates AS (
          SELECT
            toString(acsm_segments.activity_id) AS activity_id,
            acsm_segments.activity_date AS activity_date,
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
            ) / nullIf(
              (acsm_segments.average_heart_rate - resting.resting_hr)
                / (user_profile.max_hr - resting.resting_hr),
              0
            ) AS vo2max
          FROM acsm_segments
          INNER JOIN postgres_fitness.user_profile_current AS user_profile
            ON user_profile.id = {userId:UUID}
          LEFT JOIN resting_by_activity AS resting
            ON resting.activity_id = acsm_segments.activity_id
          WHERE user_profile.max_hr IS NOT NULL
            AND resting.resting_hr IS NOT NULL
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
      `,
    format: "JSONEachRow",
    query_params: userDateWindowParams(endDate, days, userId, timezone),
  });
  return result.json();
}
