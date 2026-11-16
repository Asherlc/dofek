import { computeCyclingPowerWork } from "@dofek/training/cycling-workout-metrics";
import { cyclingPowerCoveragePolicy } from "dofek/analytics/cycling-power-policy";
import { z } from "zod";
import type { ActivityPowerWork } from "../contracts/activity-metric-sources.ts";
import {
  activityMetricParams,
  activityMetricSamplesSql,
  activityMetricSourceIdSql,
} from "./activity-metric-sources-repository.ts";
import type { ActivitySensorQueryStore, ActivitySensorWindow } from "./activity-sensor-types.ts";

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
    samples.map((sample) => ({ elapsedSeconds: sample.elapsed_seconds, powerWatts: sample.power })),
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
