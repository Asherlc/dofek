import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import type { ActivitySourceTree } from "@dofek/providers/activity-source-tree";
import { z } from "zod";
import {
  ACTIVITY_CHART_METRICS,
  type ActivityMetricSources,
} from "../contracts/activity-metric-sources.ts";
import { presentActivityMetricSource } from "./activity-metric-source-presentation.ts";
import type { ActivitySensorQueryStore, ActivitySensorWindow } from "./activity-sensor-types.ts";
import { healthSensorSamplesSql } from "./health-sensor-query.ts";

/** Includes standalone recordings, but excludes recordings attached to unrelated activities. */
export const activityMetricSamplesSql = `SELECT *
  FROM analytics.sensor_scalar_sample FINAL
  WHERE user_id = {userId:UUID}
    AND {isPointOnly:Bool} = 0
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

/** Decoded temperature is filtered by strap measurement time, not the upload/reception day. */
export const activitySkinTemperatureSamplesSql = `SELECT id, CAST(NULL, 'Nullable(UUID)') AS activity_id,
    recorded_at, provider_id, source_name AS device_id, scalar,
    coalesce(device_priority, provider_priority, 1000) AS provider_priority,
    '' AS measurement_kind, 'skin_temperature' AS channel
  FROM (
    WITH temperature_candidates AS (
      SELECT *
      FROM (${healthSensorSamplesSql("skin_temperature")})
      WHERE recorded_at >= parseDateTime64BestEffort({windowStartedAt:String}, 6, 'UTC')
        AND recorded_at <= parseDateTime64BestEffort({windowEndedAt:String}, 6, 'UTC')
        AND {isPointOnly:Bool} = 0
    ),
    active_sensor_provider_priority AS (
      SELECT provider_id, toNullable(priority) AS priority
      FROM postgres_fitness.sensor_provider_priority FINAL
      WHERE channel = 'skin_temperature' AND _peerdb_is_deleted = 0
    ),
    active_sensor_device_priority AS (
      SELECT provider_id, source_name_pattern, toNullable(priority) AS priority
      FROM postgres_fitness.sensor_device_priority FINAL
      WHERE channel = 'skin_temperature' AND _peerdb_is_deleted = 0
    ),
    device_priority_match AS (
      SELECT sample_id, priority
      FROM (
        SELECT
          temperature_candidates.id AS sample_id,
          active_sensor_device_priority.priority AS priority,
          row_number() OVER (
            PARTITION BY temperature_candidates.id
            ORDER BY
              length(active_sensor_device_priority.source_name_pattern) DESC,
              active_sensor_device_priority.priority ASC,
              active_sensor_device_priority.source_name_pattern ASC
          ) AS row_number
        FROM temperature_candidates
        INNER JOIN active_sensor_device_priority
          ON active_sensor_device_priority.provider_id = temperature_candidates.provider_id
         AND temperature_candidates.source_name IS NOT NULL
         AND assumeNotNull(temperature_candidates.source_name)
           LIKE active_sensor_device_priority.source_name_pattern
      )
      WHERE row_number = 1
    )
    SELECT temperature_candidates.id AS id,
      temperature_candidates.recorded_at AS recorded_at,
      temperature_candidates.provider_id AS provider_id,
      temperature_candidates.source_name AS source_name,
      temperature_candidates.scalar AS scalar,
      device_priority_match.priority AS device_priority,
      active_sensor_provider_priority.priority AS provider_priority
    FROM temperature_candidates
    LEFT JOIN active_sensor_provider_priority
      ON active_sensor_provider_priority.provider_id = temperature_candidates.provider_id
    LEFT JOIN device_priority_match
      ON device_priority_match.sample_id = temperature_candidates.id
  ) AS selected_temperature`;

/** Keep device identities distinct, including multiple recordings delivered by Apple Health. */
export const activityMetricSourceIdSql = `if(coalesce(device_id, '') = '', provider_id, toJSONString(tuple(provider_id, device_id)))`;

export function activityMetricParams(window: ActivitySensorWindow) {
  return {
    userId: window.userId,
    isPointOnly: window.providerType === "climbing_log",
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
  activity_ids: z.array(z.string()),
  sample_count: z.coerce.number(),
});
const deviceNameSchema = z.object({
  provider_id: z.string(),
  device_id: z.string(),
  device_name: z.string(),
});

export async function getActivityMetricSources(
  store: ActivitySensorQueryStore,
  window: ActivitySensorWindow,
  hardware: ActivityHardware = { items: [], power: [] },
  sourceTree: ActivitySourceTree = { primary: null, otherSources: [] },
): Promise<ActivityMetricSources> {
  const rows = await store.query(
    sourceRowSchema,
    `
    WITH source_candidates AS (
      SELECT id, activity_id, recorded_at, channel, provider_id, device_id, provider_priority
      FROM (${activityMetricSamplesSql})
      UNION ALL
      SELECT id, activity_id, recorded_at, channel, provider_id, device_id, provider_priority
      FROM (${activitySkinTemperatureSamplesSql})
    ), source_samples AS (
      SELECT *, ${activityMetricSourceIdSql} AS source_id FROM source_candidates
    )
    SELECT channel, provider_id, source_id, any(nullIf(device_id, '')) AS device_id,
      groupUniqArray(ifNull(toString(activity_id), '')) AS activity_ids,
      uniqExact(recorded_at) AS sample_count
    FROM source_samples
    GROUP BY channel, provider_id, source_id
    ORDER BY channel, min(provider_priority), provider_id, min(id), source_id`,
    activityMetricParams(window),
  );
  const peripheralIds = rows
    .filter((row) => row.provider_id === "ble_heart_rate" && row.device_id !== null)
    .map((row) => row.device_id);
  // Raw storage is ordered by user/activity/channel/time; keep this lookup within
  // the same eligible activity window and only request the selected peripherals.
  const peripheralNames = peripheralIds.length
    ? await store.query(
        deviceNameSchema,
        `
    SELECT provider_id, assumeNotNull(device_id) AS device_id,
      argMax(JSONExtractString(metadata, 'device_name'), tuple(recorded_at, version, id)) AS device_name
    FROM ingest.metric_stream FINAL
    WHERE user_id = {userId:UUID} AND provider_id = 'ble_heart_rate'
      AND device_id IN {peripheralIds:Array(String)}
      AND channel IN ('heart_rate', 'rr_interval_ms')
      AND recorded_at >= parseDateTime64BestEffort({windowStartedAt:String}, 6, 'UTC')
      AND recorded_at <= parseDateTime64BestEffort({windowEndedAt:String}, 6, 'UTC')
      AND (activity_id IS NULL OR activity_id IN (SELECT arrayJoin(CAST({memberActivityIds:Array(String)}, 'Array(UUID)'))))
      AND is_deleted = 0 AND scalar > 0 AND JSONExtractString(metadata, 'device_name') != ''
    GROUP BY provider_id, device_id`,
        { ...activityMetricParams(window), peripheralIds },
      )
    : [];
  return ACTIVITY_CHART_METRICS.flatMap((metric) => {
    const metricRows = rows.filter((row) => row.channel === metric.channel);
    if (metric.key === "heartRate") {
      const directlyRecorded = (row: z.infer<typeof sourceRowSchema>) =>
        row.activity_ids.some((id) => window.memberActivityIds.includes(id)) ||
        hardware.items.some(
          (item) =>
            item.role === "recorder" &&
            window.memberActivityIds.includes(item.activityId) &&
            item.providerId === row.provider_id &&
            row.device_id !== null &&
            row.device_id === item.sourceName,
        );
      // Stable sorting preserves provider priority for equal recording evidence and counts.
      metricRows.sort(
        (left, right) =>
          Number(directlyRecorded(right)) - Number(directlyRecorded(left)) ||
          right.sample_count - left.sample_count,
      );
    }
    const sources = metricRows.map((row) =>
      presentActivityMetricSource(
        row,
        hardware,
        sourceTree,
        peripheralNames.find(
          (device) => device.provider_id === row.provider_id && device.device_id === row.device_id,
        )?.device_name,
      ),
    );
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
