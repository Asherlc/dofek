import { TupleParam } from "@clickhouse/client";
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

export interface CyclingSampleRowOptions {
  /**
   * Power is counted only for these authorized (canonical activity, member activity) pairs.
   * Membership comes from the caller's authorized Postgres read, not the analytics read model.
   */
  authorizedPowerLinks?: Array<{ activityId: string; memberActivityId: string }>;
}

/**
 * Deduplicated per-second samples for canonical activity IDs, limited to the requested channels.
 * Offsets count from the analytics activity start, or from `startedAt` when the caller's interval
 * offsets come from another store, so laps and samples share one clock origin.
 */
export async function loadCyclingSampleRows(
  store: Pick<ActivitySensorStore, "query">,
  userId: string,
  activityIds: string[],
  channels: ReadonlyArray<"power" | "heart_rate" | "cadence">,
  startedAt?: string,
  options: CyclingSampleRowOptions = {},
) {
  if (activityIds.length === 0) return [];
  const origin =
    startedAt === undefined
      ? "activity.started_at"
      : "parseDateTime64BestEffort({startedAt:String}, 3, 'UTC')";
  const authorizedLinks = options.authorizedPowerLinks;
  const linkPredicate =
    authorizedLinks === undefined
      ? ""
      : `\n              AND (sensor.channel != 'power' OR (isNotNull(sensor.member_activity_id)
          AND tuple(sensor.activity_id, assumeNotNull(sensor.member_activity_id))
            IN {authorizedLinks:Array(Tuple(UUID, UUID))}))`;
  return store.query(
    sampleRowSchema,
    `/* cycling-training-metrics:samples */
            SELECT
              toString(sensor.activity_id) AS activity_id,
              dateDiff('millisecond', ${origin}, sensor.recorded_at) / 1000 AS elapsed_seconds,
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
              AND sensor.is_deleted = 0${linkPredicate}
            GROUP BY sensor.activity_id, ${origin}, sensor.recorded_at
            ORDER BY sensor.activity_id, sensor.recorded_at`,
    {
      userId,
      activityIds,
      channels: [...channels],
      ...(startedAt === undefined
        ? {}
        : { startedAt: new Date(Date.parse(startedAt)).toISOString() }),
      ...(authorizedLinks === undefined
        ? {}
        : {
            authorizedLinks: authorizedLinks.map(
              ({ activityId, memberActivityId }) => new TupleParam([activityId, memberActivityId]),
            ),
          }),
    },
  );
}
