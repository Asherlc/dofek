import { BLE_HEART_RATE_PROVIDER_ID, WHOOP_BLE_PROVIDER_ID } from "@dofek/providers/push-providers";
import { z } from "zod";
import { activityMetricSamplesSql, activityMetricSourceIdSql } from "./activity-metric-query.ts";
import type { ClickHouseClient } from "./clickhouse.ts";

const ghostScalarSampleSchema = z.object({
  id: z.string(),
  member_activity_id: z.string().nullable(),
  channel: z.enum(["heart_rate", "power", "speed", "altitude"]),
  recorded_at: z.iso.datetime(),
  scalar: z.number(),
  provider_id: z.string(),
  device_id: z.string().nullable(),
  source_id: z.string(),
  source_external_id: z.string().nullable(),
  source_type: z.string().nullable(),
  measurement_kind: z.string(),
});

interface GhostScalarWindow {
  userId: string;
  activityId: string;
  memberActivityIds: readonly string[];
  startedAt: string;
  endedAt: string;
}

/** Reads observations for a verified Ghost activity window. Missing readings stay absent. */
export async function getGhostScalarSamples(
  client: Pick<ClickHouseClient, "query">,
  window: GhostScalarWindow,
): Promise<z.infer<typeof ghostScalarSampleSchema>[]> {
  const result = await client.query({
    query: `
      WITH independent_members AS (
        SELECT activity_id, provider_id
        FROM analytics.activity_source_records FINAL
        WHERE activity_id IN (
            SELECT arrayJoin(CAST({memberActivityIds:Array(String)}, 'Array(UUID)'))
          )
          AND user_id = {userId:UUID}
          AND group_id = {activityId:UUID}
          AND is_deleted = 0
          AND provider_id != 'strava'
          AND canonical_type IN ('running', 'cycling')
          AND (modality IS NULL OR modality NOT IN ('indoor', 'virtual'))
          -- Match the Ghost GPS source-record evidence for Strava imports.
          AND NOT (
            provider_id = 'apple_health'
            AND (
              lowerUTF8(trim(BOTH ' ' FROM coalesce(source_name, ''))) = 'strava'
              OR lowerUTF8(trim(BOTH ' ' FROM JSONExtractString(
                coalesce(raw, '{}'), 'sourceBundle'
              ))) = 'com.strava.strava'
            )
          )
      ), bounded_samples AS (
        SELECT *, coalesce(member_activity_id, activity_id) AS linked_member_id
        FROM (${activityMetricSamplesSql})
        WHERE channel IN ('heart_rate', 'power', 'speed', 'altitude')
          AND provider_id != 'strava'
          AND (member_activity_id IS NULL OR activity_id IS NULL OR member_activity_id = activity_id)
      )
      SELECT id, linked_member_id AS member_activity_id, channel,
        formatDateTime(recorded_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS recorded_at,
        scalar, provider_id, device_id, ${activityMetricSourceIdSql} AS source_id,
        source_external_id, source_type, measurement_kind
      FROM bounded_samples
      WHERE (linked_member_id, provider_id) IN (SELECT activity_id, provider_id FROM independent_members)
        OR (
          linked_member_id IS NULL
          AND EXISTS (SELECT 1 FROM independent_members)
          AND source_type = 'ble'
          AND provider_id IN {directBleProviders:Array(String)}
          AND notEmpty(coalesce(device_id, ''))
        )
      -- Use the ordinary deduped_sensor priority and tie-breaks on eligible candidates.
      ORDER BY bounded_samples.recorded_at, channel, provider_priority, provider_id,
        channel = 'heart_rate' AND measurement_kind = 'estimated', id
      LIMIT 1 BY channel, bounded_samples.recorded_at`,
    format: "JSONEachRow",
    query_params: {
      userId: window.userId,
      activityId: window.activityId,
      memberActivityIds: window.memberActivityIds,
      windowStartedAt: window.startedAt,
      windowEndedAt: window.endedAt,
      isPointOnly: false,
      directBleProviders: [BLE_HEART_RATE_PROVIDER_ID, WHOOP_BLE_PROVIDER_ID],
    },
  });
  return ghostScalarSampleSchema.array().parse(await result.json());
}
