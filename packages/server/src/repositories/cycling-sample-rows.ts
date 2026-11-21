import { z } from "zod";
import type { ActivitySensorStore } from "./activity-repository.ts";

export const sampleRowSchema = z.object({
  activity_id: z.string().uuid(),
  elapsed_seconds: z.coerce.number().nonnegative(),
  power: z.coerce.number().nullable(),
  heart_rate: z.coerce.number().nullable(),
  cadence: z.coerce.number().nullable(),
  source_providers: z.array(z.string()),
  source_devices: z.array(z.string()),
  power_measurement_kinds: z.array(z.enum(["direct", "estimated", "unknown"])),
  stream_evidence: z.array(
    z.tuple([
      z.enum(["power", "heart_rate", "cadence"]),
      z.string().nullable(),
      z.string().nullable(),
      z.enum(["direct", "estimated", "unknown"]),
    ]),
  ),
});

/** Deduplicated per-second samples for canonical activity IDs, limited to the requested channels. */
export async function loadCyclingSampleRows(
  store: Pick<ActivitySensorStore, "query">,
  userId: string,
  activityIds: string[],
  channels: ReadonlyArray<"power" | "heart_rate" | "cadence">,
) {
  if (activityIds.length === 0) return [];
  return store.query(
    sampleRowSchema,
    `/* cycling-training-metrics:samples */
            SELECT
              toString(sensor.activity_id) AS activity_id,
              dateDiff('millisecond', activity.started_at, sensor.recorded_at) / 1000 AS elapsed_seconds,
              if(countIf(sensor.channel = 'power') = 0, NULL,
                maxIf(sensor.scalar, sensor.channel = 'power')) AS power,
              if(countIf(sensor.channel = 'heart_rate') = 0, NULL,
                maxIf(sensor.scalar, sensor.channel = 'heart_rate')) AS heart_rate,
              if(countIf(sensor.channel = 'cadence') = 0, NULL,
                maxIf(sensor.scalar, sensor.channel = 'cadence')) AS cadence,
              arraySort(groupUniqArrayIf(sensor.provider_id, sensor.provider_id != '')) AS source_providers,
              arraySort(groupUniqArrayIf(sensor.device_id, sensor.device_id != '')) AS source_devices,
              arraySort(groupUniqArrayIf(sensor.measurement_kind,
                sensor.channel = 'power' AND sensor.measurement_kind != '')) AS power_measurement_kinds,
              arraySort(groupUniqArray(tuple(sensor.channel, sensor.provider_id,
                sensor.device_id, sensor.measurement_kind))) AS stream_evidence
            FROM analytics.activity_sensor_sample AS sensor FINAL
            INNER JOIN analytics.deduped_activities AS activity FINAL
              ON activity.activity_id = sensor.activity_id AND activity.user_id = sensor.user_id
            WHERE sensor.user_id = {userId:UUID}
              AND sensor.activity_id IN ({activityIds:Array(UUID)})
              AND sensor.channel IN ({channels:Array(String)})
              AND sensor.is_deleted = 0
            GROUP BY sensor.activity_id, activity.started_at, sensor.recorded_at
            ORDER BY sensor.activity_id, sensor.recorded_at`,
    { userId, activityIds, channels: [...channels] },
  );
}
