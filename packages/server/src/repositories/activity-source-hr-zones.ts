import { mapHrZones } from "@dofek/zones/zones";
import { z } from "zod";
import {
  activityMetricParams,
  activityMetricSamplesSql,
  activityMetricSourceIdSql,
} from "./activity-metric-sources-repository.ts";
import type { ActivitySensorQueryStore, ActivitySensorWindow } from "./activity-sensor-types.ts";
import { heartRateZoneCountColumns, heartRateZoneSqlParams } from "./heart-rate-zone-sql.ts";

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
