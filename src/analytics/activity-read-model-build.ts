import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE } from "../metric-stream/clickhouse-table.ts";

export interface WaitForPeerDbActivityDeletesOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const metricStreamDeleteAcknowledgementCountRowsSchema = z.array(
  z.object({ acknowledgement_count: z.coerce.number().int().nonnegative() }),
);

export async function countActivePeerDbActivities(
  client: ClickHouseClient,
  activityIds: string[],
): Promise<number> {
  if (activityIds.length === 0) return 0;

  const rows = await client.query<{ active_count: string | number }>({
    query: `SELECT count() AS active_count
      FROM postgres_fitness.activity FINAL
      WHERE toString(id) IN {activityIds:Array(String)}
        AND _peerdb_is_deleted = 0
        AND coalesce(provider_absent_at, toDateTime64(0, 6, 'UTC')) = toDateTime64(0, 6, 'UTC')
        AND coalesce(deleted_at, toDateTime64(0, 6, 'UTC')) = toDateTime64(0, 6, 'UTC')`,
    format: "JSONEachRow",
    query_params: { activityIds },
  });
  const row = (await rows.json())[0];
  return Number(row?.active_count ?? 0);
}

export async function countProviderAbsentPeerDbActivities(
  client: ClickHouseClient,
  activityIds: string[],
): Promise<number> {
  if (activityIds.length === 0) return 0;

  const rows = await client.query<{ absent_count: string | number }>({
    query: `SELECT count() AS absent_count
      FROM postgres_fitness.activity FINAL
      WHERE toString(id) IN {activityIds:Array(String)}
        AND _peerdb_is_deleted = 0
        AND coalesce(provider_absent_at, toDateTime64(0, 6, 'UTC')) != toDateTime64(0, 6, 'UTC')`,
    format: "JSONEachRow",
    query_params: { activityIds },
  });
  const row = (await rows.json())[0];
  return Number(row?.absent_count ?? 0);
}

export async function waitForPeerDbActivityDeletes(
  client: ClickHouseClient,
  activityIds: string[],
  options: WaitForPeerDbActivityDeletesOptions = {},
): Promise<void> {
  const uniqueActivityIds = [...new Set(activityIds)];
  if (uniqueActivityIds.length === 0) return;

  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const activeCount = await countActivePeerDbActivities(client, uniqueActivityIds);
    if (activeCount === 0) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for PeerDB to reflect deletion of ${uniqueActivityIds.length} activities`,
  );
}

export async function waitForPeerDbActivityRestores(
  client: ClickHouseClient,
  activityIds: string[],
  options: WaitForPeerDbActivityDeletesOptions = {},
): Promise<void> {
  const uniqueActivityIds = [...new Set(activityIds)];
  if (uniqueActivityIds.length === 0) return;

  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const absentCount = await countProviderAbsentPeerDbActivities(client, uniqueActivityIds);
    if (absentCount === 0) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for PeerDB to reflect restoration of ${uniqueActivityIds.length} activities`,
  );
}

async function countMetricStreamDeleteAcknowledgements(
  client: ClickHouseClient,
  eventId: string,
): Promise<number> {
  const result = await client.query({
    query: `SELECT count() AS acknowledgement_count
      FROM ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE}
      WHERE event_id = {eventId:UUID}`,
    format: "JSONEachRow",
    query_params: { eventId },
  });
  const rows = metricStreamDeleteAcknowledgementCountRowsSchema.parse(await result.json());
  return rows[0]?.acknowledgement_count ?? 0;
}

export async function waitForMetricStreamDeleteAcknowledgement(
  client: ClickHouseClient,
  eventId: string,
  options: WaitForPeerDbActivityDeletesOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const acknowledgementCount = await countMetricStreamDeleteAcknowledgements(client, eventId);
    if (acknowledgementCount > 0) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for ClickHouse to acknowledge metric-stream deletion event ${eventId}`,
  );
}

export async function countActivePeerDbProviderRows(
  client: ClickHouseClient,
  userId: string,
  providerId: string,
): Promise<number> {
  const rows = await client.query<{ active_count: string | number }>({
    query: `SELECT sum(active_count) AS active_count
      FROM (
        SELECT count() AS active_count FROM postgres_fitness.activity FINAL
          WHERE user_id = {userId:UUID} AND provider_id = {providerId:String} AND _peerdb_is_deleted = 0
        UNION ALL
        SELECT count() AS active_count FROM postgres_fitness.daily_metrics FINAL
          WHERE user_id = {userId:UUID} AND provider_id = {providerId:String} AND _peerdb_is_deleted = 0
        UNION ALL
        SELECT count() AS active_count FROM postgres_fitness.sleep_session FINAL
          WHERE user_id = {userId:UUID} AND provider_id = {providerId:String} AND _peerdb_is_deleted = 0
        UNION ALL
        SELECT count() AS active_count FROM postgres_fitness.food_entry FINAL
          WHERE user_id = {userId:UUID} AND provider_id = {providerId:String} AND _peerdb_is_deleted = 0
        UNION ALL
        SELECT count() AS active_count FROM postgres_fitness.health_event FINAL
          WHERE user_id = {userId:UUID} AND provider_id = {providerId:String} AND _peerdb_is_deleted = 0
        UNION ALL
        SELECT count() AS active_count FROM postgres_fitness.clinical_record FINAL
          WHERE user_id = {userId:UUID} AND provider_id = {providerId:String} AND _peerdb_is_deleted = 0
      )`,
    format: "JSONEachRow",
    query_params: { userId, providerId },
  });
  const row = (await rows.json())[0];
  return Number(row?.active_count ?? 0);
}

export async function waitForPeerDbProviderDeletes(
  client: ClickHouseClient,
  userId: string,
  providerId: string,
  options: WaitForPeerDbActivityDeletesOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const activeCount = await countActivePeerDbProviderRows(client, userId, providerId);
    if (activeCount === 0) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out waiting for PeerDB to reflect provider deletion for provider ${providerId}`,
  );
}
