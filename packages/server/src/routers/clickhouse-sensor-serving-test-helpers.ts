import type { ClickHouseClient } from "../../../../src/db/clickhouse.ts";
import type { ClickHouseMetricStreamSeedRow } from "./clickhouse-integration-test-helpers.ts";

interface SensorServingSeedRow
  extends Pick<
    ClickHouseMetricStreamSeedRow,
    "userId" | "recordedAt" | "channel" | "providerId" | "deviceId" | "externalId" | "sourceType"
  > {
  scalar: number | null;
  memberActivityId: string | null;
  sourceActivityId: string | null;
  sourceMetricStreamId: string | null;
  measurementKind: "direct" | "estimated" | "unknown";
  providerPriority: number;
  refreshVersion: number;
  isDeleted: boolean;
}

interface ScalarSampleSeedRow extends SensorServingSeedRow {
  id: string;
  activityId: string | null;
  scalar: number;
  sourceVersion: number;
}

/** Inserts fixture-selected outputs; callers own membership and winner decisions. */
export async function seedClickHouseSensorServingRows(
  client: ClickHouseClient,
  rows: {
    scalarSamples: readonly ScalarSampleSeedRow[];
    winners: readonly SensorServingSeedRow[];
  },
): Promise<void> {
  if (!client.insert) throw new Error("ClickHouse serving fixture requires inserts");
  const refreshedAt = new Date().toISOString();
  if (rows.scalarSamples.length > 0) {
    await client.insert({
      table: "analytics.sensor_scalar_sample",
      format: "JSONEachRow",
      clickhouse_settings: { date_time_input_format: "best_effort" },
      values: rows.scalarSamples.map((row) => ({
        id: row.id,
        activity_id: row.activityId,
        member_activity_id: row.memberActivityId,
        user_id: row.userId,
        recorded_at: row.recordedAt,
        recorded_date: row.recordedAt.slice(0, 10),
        channel: row.channel,
        provider_id: row.providerId,
        source_external_id: row.externalId ?? null,
        device_id: row.deviceId ?? null,
        source_type: row.sourceType ?? null,
        measurement_kind: row.measurementKind,
        scalar: row.scalar,
        provider_priority: row.providerPriority,
        _peerdb_synced_at: refreshedAt,
        _peerdb_is_deleted: Number(row.isDeleted),
        _peerdb_version: row.sourceVersion,
        refresh_version: row.refreshVersion,
      })),
    });
  }
  if (rows.winners.length > 0) {
    await client.insert({
      table: "analytics.deduped_sensor",
      format: "JSONEachRow",
      clickhouse_settings: { date_time_input_format: "best_effort" },
      values: rows.winners.map((row) => ({
        user_id: row.userId,
        recorded_at: row.recordedAt,
        recorded_date: row.recordedAt.slice(0, 10),
        channel: row.channel,
        scalar: row.scalar,
        provider_id: row.providerId,
        member_activity_id: row.memberActivityId,
        device_id: row.deviceId ?? null,
        source_external_id: row.externalId ?? null,
        source_type: row.sourceType ?? null,
        measurement_kind: row.measurementKind,
        source_metric_stream_id: row.sourceMetricStreamId,
        source_activity_id: row.sourceActivityId,
        provider_priority: row.providerPriority,
        source_refreshed_at: refreshedAt,
        refresh_version: row.refreshVersion,
        is_deleted: Number(row.isDeleted),
        refreshed_at: refreshedAt,
      })),
    });
  }
}
