import { providerRecordLabel, providerSourceLabel } from "@dofek/providers/providers";
import { mapHrZones } from "@dofek/zones/zones";
import { z } from "zod";
import {
  ACTIVITY_CHART_METRICS,
  type ActivityMetricSources,
} from "../contracts/activity-metric-sources.ts";
import type { ActivitySensorQueryStore, ActivitySensorWindow } from "./activity-sensor-types.ts";
import { heartRateZoneCountColumns, heartRateZoneSqlParams } from "./heart-rate-zone-sql.ts";

/** Includes standalone recordings, but excludes recordings attached to unrelated activities. */
export const activityMetricSamplesSql = `SELECT *
  FROM analytics.sensor_scalar_sample FINAL
  WHERE user_id = {userId:UUID}
    AND channel IN ('heart_rate', 'power', 'speed', 'cadence', 'altitude')
    AND recorded_date >= toDate(parseDateTime64BestEffort({windowStartedAt:String}, 6, 'UTC'))
    AND recorded_date <= toDate(parseDateTime64BestEffort({windowEndedAt:String}, 6, 'UTC'))
    AND recorded_at >= parseDateTime64BestEffort({windowStartedAt:String}, 6, 'UTC')
    AND recorded_at <= parseDateTime64BestEffort({windowEndedAt:String}, 6, 'UTC')
    AND (activity_id IS NULL OR activity_id IN (
      SELECT arrayJoin(CAST({memberActivityIds:Array(String)}, 'Array(UUID)'))
    ))
    AND _peerdb_is_deleted = 0
    AND (channel != 'heart_rate' OR scalar > 0)`;

/** Keep device identities distinct, including multiple recordings delivered by Apple Health. */
export const activityMetricSourceIdSql = `if(coalesce(device_id, '') = '', provider_id, toJSONString(tuple(provider_id, device_id)))`;

export function activityMetricParams(window: ActivitySensorWindow) {
  return {
    userId: window.userId,
    windowStartedAt: window.startedAt,
    windowEndedAt:
      window.endedAt ?? new Date(Date.parse(window.startedAt) + 12 * 60 * 60 * 1000).toISOString(),
    memberActivityIds: window.memberActivityIds,
  };
}

const sourceRowSchema = z.object({
  channel: z.string(),
  provider_id: z.string(),
  device_id: z.string().nullable(),
  source_id: z.string(),
});

export async function getActivityMetricSources(
  store: ActivitySensorQueryStore,
  window: ActivitySensorWindow,
): Promise<ActivityMetricSources> {
  const rows = await store.query(
    sourceRowSchema,
    `
    WITH source_samples AS (
      SELECT *, ${activityMetricSourceIdSql} AS source_id FROM (${activityMetricSamplesSql})
    )
    SELECT channel, provider_id, source_id, any(nullIf(device_id, '')) AS device_id
    FROM source_samples
    GROUP BY channel, provider_id, source_id
    ORDER BY channel, min(provider_priority), provider_id, min(id), source_id`,
    activityMetricParams(window),
  );
  return ACTIVITY_CHART_METRICS.flatMap((metric) => {
    const sources = rows
      .filter((row) => row.channel === metric.channel)
      .map((row) => ({
        id: row.source_id,
        label:
          row.provider_id === "apple_health" || row.provider_id === "whoop_ble"
            ? providerSourceLabel(row.provider_id, row.device_id)
            : providerRecordLabel(row.provider_id, row.device_id),
      }));
    const first = sources[0];
    return first
      ? [
          {
            key: metric.key,
            label: metric.label,
            sources: [first, ...sources.slice(1)],
            defaultSourceId: first.id,
          },
        ]
      : [];
  });
}

const zoneCountsSchema = z.object({
  zone0: z.coerce.number(),
  zone1: z.coerce.number(),
  zone2: z.coerce.number(),
  zone3: z.coerce.number(),
  zone4: z.coerce.number(),
  zone5: z.coerce.number(),
});

/** Uses the same pre-activity resting HR baseline and Karvonen thresholds as the default zones. */
export async function getActivitySourceHrZones(
  store: ActivitySensorQueryStore,
  window: ActivitySensorWindow,
  heartRateSourceId: string,
) {
  const rows = await store.query(
    zoneCountsSchema,
    `
    WITH recent_resting AS (
      SELECT resting_hr
      FROM analytics.resting_heart_rate_sleep_window FINAL
      WHERE user_id = {userId:UUID} AND is_deleted = 0
        AND ended_at <= parseDateTime64BestEffort({windowStartedAt:String}, 6, 'UTC')
        AND resting_hr > 0
      ORDER BY ended_at DESC
      LIMIT 14
    ), baseline AS (
      SELECT quantileExactInclusive(0.5)(toFloat64(resting_hr)) AS resting_hr FROM recent_resting
    ), profile AS (
      SELECT max_hr,
        multiIf(
          (SELECT resting_hr FROM baseline) > 0 AND (SELECT resting_hr FROM baseline) < max_hr,
          (SELECT resting_hr FROM baseline),
          resting_hr > 0 AND resting_hr < max_hr, resting_hr,
          least(60, max_hr - 1)
        ) AS effective_resting_hr
      FROM postgres_fitness.user_profile_current
      WHERE id = {userId:UUID} AND max_hr > 1
    ), samples AS (
      SELECT recorded_at,
        argMin(scalar, (provider_priority, provider_id, measurement_kind = 'estimated', id)) AS scalar
      FROM (${activityMetricSamplesSql})
      WHERE channel = 'heart_rate' AND ${activityMetricSourceIdSql} = {heartRateSourceId:String}
      GROUP BY recorded_at
    )
    SELECT ${heartRateZoneCountColumns("scalar", { maxHr: "max_hr", restingHr: "effective_resting_hr" })}
    FROM samples CROSS JOIN profile`,
    {
      ...activityMetricParams(window),
      heartRateSourceId,
      ...heartRateZoneSqlParams(),
    },
  );
  const row = rows[0];
  return mapHrZones(
    row
      ? Object.entries(row).map(([key, seconds]) => ({ zone: Number(key.slice(4)), seconds }))
      : [],
  );
}
