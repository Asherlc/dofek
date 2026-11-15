import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import {
  activityMetricSourcePresentation,
  activityMetricSourceText,
} from "@dofek/providers/activity-metric-source";
import {
  type ActivitySourceTree,
  activityMetricSourceInheritance,
} from "@dofek/providers/activity-source-tree";
import { providerRecordLabel, providerSourceLabel } from "@dofek/providers/providers";
import { computeCyclingPowerWork } from "@dofek/training/cycling-workout-metrics";
import { mapHrZones } from "@dofek/zones/zones";
import { cyclingPowerCoveragePolicy } from "dofek/analytics/cycling-power-policy";
import { z } from "zod";
import {
  ACTIVITY_CHART_METRICS,
  type ActivityHeartRateContext,
  type ActivityMetricSourceSelection,
  type ActivityMetricSources,
  type ActivityPowerWork,
} from "../contracts/activity-metric-sources.ts";
import type { ActivitySensorQueryStore, ActivitySensorWindow } from "./activity-sensor-types.ts";
import { healthSensorSamplesSql } from "./health-sensor-query.ts";
import { heartRateZoneCountColumns, heartRateZoneSqlParams } from "./heart-rate-zone-sql.ts";

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

interface HeartRateStreamStore {
  getStream(
    window: ActivitySensorWindow,
    maxPoints: number,
    sources: ActivityMetricSourceSelection,
  ): Promise<Array<{ recorded_at: string; heart_rate: number | null }>>;
}

/** Display context only; activity summaries and zones retain the recorded window. */
export async function getActivityHeartRateContext(
  store: HeartRateStreamStore,
  window: ActivitySensorWindow,
  maxPoints: number,
  heartRateSourceId: string | undefined,
): Promise<ActivityHeartRateContext> {
  const marginMs = 5 * 60 * 1000;
  const chartWindow = {
    startedAt: new Date(Date.parse(window.startedAt) - marginMs).toISOString(),
    endedAt: window.endedAt ? new Date(Date.parse(window.endedAt) + marginMs).toISOString() : null,
  };
  const points = heartRateSourceId
    ? await store.getStream({ ...window, ...chartWindow }, maxPoints, {
        heartRate: heartRateSourceId,
      })
    : [];
  return {
    window: chartWindow,
    points: points
      .filter((point) => point.heart_rate !== null)
      .map((point) => ({
        recordedAt: point.recorded_at,
        value: point.heart_rate,
      })),
  };
}

const powerSampleSchema = z.object({
  elapsed_seconds: z.coerce.number(),
  power: z.coerce.number().nullable(),
});

/** Mechanical work from full power samples, with the same gap policy as cycling analytics. */
export async function getActivityPowerWork(
  store: ActivitySensorQueryStore,
  window: ActivitySensorWindow,
  powerSourceId?: string,
): Promise<ActivityPowerWork> {
  const durationSeconds = window.endedAt
    ? Math.floor((Date.parse(window.endedAt) - Date.parse(window.startedAt)) / 1_000)
    : 0;
  if (durationSeconds <= 0) {
    return { workKilojoules: null, coverage: { coveredSeconds: 0, coveragePct: 0 } };
  }
  const samples = await store.query(
    powerSampleSchema,
    `WITH samples AS (
      ${
        powerSourceId
          ? `SELECT recorded_at, argMin(scalar, (provider_priority, provider_id, id)) AS power
        FROM (${activityMetricSamplesSql})
        WHERE channel = 'power' AND ${activityMetricSourceIdSql} = {powerSourceId:String}
        GROUP BY recorded_at`
          : `SELECT recorded_at, scalar AS power
        FROM analytics.activity_sensor_sample FINAL
        WHERE user_id = {userId:UUID} AND activity_id = {activityId:UUID}
          AND recorded_at >= parseDateTime64BestEffort({windowStartedAt:String}, 6, 'UTC')
          AND recorded_at <= parseDateTime64BestEffort({windowEndedAt:String}, 6, 'UTC')
          AND channel = 'power' AND is_deleted = 0`
      }
    )
    SELECT dateDiff('millisecond', parseDateTime64BestEffort({windowStartedAt:String}, 6, 'UTC'), recorded_at) / 1000 AS elapsed_seconds,
      power FROM samples ORDER BY recorded_at`,
    {
      ...activityMetricParams(window),
      activityId: window.activityId,
      ...(powerSourceId ? { powerSourceId } : {}),
    },
  );
  const metrics = computeCyclingPowerWork(
    samples.map((sample) => ({
      elapsedSeconds: sample.elapsed_seconds,
      powerWatts: sample.power,
    })),
    durationSeconds,
    cyclingPowerCoveragePolicy,
  );
  return {
    workKilojoules: metrics.workKilojoules,
    coverage: {
      coveredSeconds: metrics.coverage.coveredSeconds,
      coveragePct: metrics.coverage.coveragePct,
    },
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
    const sources = metricRows.map((row) => {
      // A workout's ancestry does not override an explicitly attributed sample device.
      const inherited =
        row.device_id === null
          ? activityMetricSourceInheritance(sourceTree, row.activity_ids, row.provider_id)
          : null;
      const peripheralName = peripheralNames.find(
        (device) => device.provider_id === row.provider_id && device.device_id === row.device_id,
      )?.device_name;
      const originalLabel =
        inherited?.label ??
        (row.provider_id === "apple_health" || row.provider_id === "whoop_ble"
          ? providerSourceLabel(row.provider_id, row.device_id)
          : providerRecordLabel(row.provider_id, peripheralName ?? row.device_id));
      const provenance = hardware.items.filter(
        (item) =>
          item.providerId === row.provider_id &&
          row.activity_ids.includes(item.activityId) &&
          (row.device_id === null ||
            row.device_id === item.sourceName ||
            row.device_id === item.label),
      );
      const role = provenance.some((item) => item.role === "recorder") ? "recorder" : "creator";
      const matching = provenance.filter((item) => item.role === role);
      const labels = [...new Set(matching.map((item) => item.label))];
      const name =
        labels.length === 1 &&
        row.activity_ids.every((id) => matching.some((item) => item.activityId === id))
          ? labels[0]
          : undefined;
      let label = originalLabel;
      if (name) {
        const includesHardwareName = originalLabel
          .replace(/\s+/g, " ")
          .toLowerCase()
          .includes(name.replace(/\s+/g, " ").toLowerCase());
        if (role === "recorder") {
          label = includesHardwareName ? originalLabel : `${originalLabel} · recorded by ${name}`;
        } else {
          const baseLabel =
            includesHardwareName && !inherited
              ? providerRecordLabel(row.provider_id, null)
              : originalLabel;
          label = `${baseLabel} · file created by ${name}`;
        }
      }
      const presentation =
        inherited?.presentation ??
        activityMetricSourcePresentation(
          row.provider_id,
          peripheralName ?? row.device_id,
          label,
          name,
        );
      return {
        id: row.source_id,
        label,
        presentation:
          inherited &&
          role === "recorder" &&
          name &&
          activityMetricSourceText(presentation) === null
            ? { ...presentation, displayName: name }
            : presentation,
      };
    });
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
