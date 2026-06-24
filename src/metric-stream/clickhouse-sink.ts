import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { METRIC_STREAM_TABLE } from "./clickhouse-table.ts";
import {
  isMetricStreamDeletedEvent,
  type MetricStreamDeleteScope,
  type MetricStreamEventV1,
  type MetricStreamRedpandaEvent,
} from "./events.ts";
import {
  createKafkaMetricStreamConsumerFromEnv,
  runMetricStreamEventConsumer,
} from "./redpanda-consumer.ts";

export interface ClickHouseMetricStreamInsertClient {
  command?(options: { query: string; query_params?: Record<string, unknown> }): Promise<unknown>;
  insert(options: {
    table: typeof METRIC_STREAM_TABLE;
    values: readonly ClickHouseMetricStreamRow[];
    format: "JSONEachRow";
    clickhouse_settings?: Record<string, string | number | boolean>;
  }): Promise<unknown>;
}

export interface ClickHouseMetricStreamRow {
  recorded_at: string;
  user_id: string;
  provider_id: string;
  external_id: string | null;
  device_id: string | null;
  source_type: string;
  channel: string;
  activity_id: string | null;
  scalar: number | null;
  point: string | null;
  id: string;
  ingested_at: string;
  is_deleted: 0 | 1;
  version: number;
}

function isClickHouseReplicatedEvent(event: MetricStreamEventV1): boolean {
  return event.channel !== "imu";
}

function normalizePointForClickHouse(point: string | null | undefined): string | null {
  if (!point) return null;

  const ewktMatch = /^SRID=4326;POINT\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)$/.exec(point);
  if (!ewktMatch) return point;

  const longitude = Number(ewktMatch[1]);
  const latitude = Number(ewktMatch[2]);
  return JSON.stringify({
    type: "Point",
    coordinates: [longitude, latitude],
  });
}

export function mapMetricStreamEventToClickHouseRow(
  event: MetricStreamEventV1,
): ClickHouseMetricStreamRow {
  return {
    recorded_at: event.recordedAt,
    user_id: event.userId,
    provider_id: event.providerId,
    external_id: event.externalId ?? null,
    device_id: event.deviceId ?? null,
    source_type: event.sourceType,
    channel: event.channel,
    activity_id: event.activityId ?? null,
    scalar: event.scalar ?? null,
    point: normalizePointForClickHouse(event.point),
    id: event.id,
    ingested_at: new Date().toISOString(),
    is_deleted: 0,
    version: 0,
  };
}

export async function insertMetricStreamEventsIntoClickHouse(
  client: ClickHouseMetricStreamInsertClient,
  events: readonly MetricStreamEventV1[],
): Promise<number> {
  const rows = events.filter(isClickHouseReplicatedEvent).map(mapMetricStreamEventToClickHouseRow);

  if (rows.length === 0) {
    return 0;
  }

  await client.insert({
    table: METRIC_STREAM_TABLE,
    values: rows,
    format: "JSONEachRow",
    // recorded_at / ingested_at are ISO-8601 strings with a trailing Z;
    // ClickHouse only accepts that offset format with best_effort datetime parsing.
    clickhouse_settings: { date_time_input_format: "best_effort" },
  });

  return rows.length;
}

function clickHouseDeleteScopeConditions(
  scope: MetricStreamDeleteScope,
  queryParams: Record<string, unknown>,
): string[] {
  const conditions: string[] = [];
  if (scope.userId) {
    queryParams.user_id = scope.userId;
    conditions.push("toString(user_id) = {user_id:String}");
  }
  if (scope.providerId) {
    queryParams.provider_id = scope.providerId;
    conditions.push("provider_id = {provider_id:String}");
  }
  if (scope.externalId !== undefined) {
    queryParams.external_id = scope.externalId;
    conditions.push("external_id = {external_id:String}");
  }
  if (scope.channel) {
    queryParams.channel = scope.channel;
    conditions.push("channel = {channel:String}");
  }
  if (scope.activityId) {
    queryParams.activity_id = scope.activityId;
    conditions.push("toString(activity_id) = {activity_id:String}");
  }
  if (scope.recordedAtStart) {
    queryParams.recorded_at_start = scope.recordedAtStart;
    conditions.push("recorded_at >= parseDateTime64BestEffort({recorded_at_start:String})");
  }
  if (scope.recordedAtEnd) {
    queryParams.recorded_at_end = scope.recordedAtEnd;
    conditions.push("recorded_at < parseDateTime64BestEffort({recorded_at_end:String})");
  }
  if (conditions.length === 0) {
    throw new Error("Metric stream delete scope produced no ClickHouse conditions");
  }
  return conditions;
}

export async function markMetricStreamScopeDeletedInClickHouse(
  client: ClickHouseMetricStreamInsertClient,
  scope: MetricStreamDeleteScope,
): Promise<void> {
  if (!client.command) {
    throw new Error("ClickHouse metric-stream replacement requires a command-capable client");
  }
  const queryParams: Record<string, unknown> = {
    delete_version: Date.now(),
  };
  const conditions = clickHouseDeleteScopeConditions(scope, queryParams);
  await client.command({
    query: `INSERT INTO ${METRIC_STREAM_TABLE}
      SELECT
        id,
        activity_id,
        user_id,
        recorded_at,
        channel,
        provider_id,
        external_id,
        device_id,
        source_type,
        scalar,
        vector,
        point,
        metadata,
        now64(9) AS ingested_at,
        1 AS is_deleted,
        greatest(version + 1, {delete_version:Int64}) AS version
      FROM ${METRIC_STREAM_TABLE} FINAL
      WHERE is_deleted = 0
        AND ${conditions.join(" AND ")}`,
    query_params: queryParams,
  });
}

export async function applyMetricStreamEventsToClickHouse(
  client: ClickHouseMetricStreamInsertClient,
  events: readonly MetricStreamRedpandaEvent[],
): Promise<number> {
  let inserted = 0;
  let rowBuffer: MetricStreamEventV1[] = [];
  const flushRows = async () => {
    if (rowBuffer.length === 0) return;
    inserted += await insertMetricStreamEventsIntoClickHouse(client, rowBuffer);
    rowBuffer = [];
  };

  for (const event of events) {
    if (isMetricStreamDeletedEvent(event)) {
      await flushRows();
      await markMetricStreamScopeDeletedInClickHouse(client, event.scope);
      continue;
    }
    rowBuffer.push(event);
  }

  await flushRows();
  return inserted;
}

function hasClickHouseInsertClient(
  client: ClickHouseClient,
): client is ClickHouseClient & ClickHouseMetricStreamInsertClient {
  return typeof client.insert === "function";
}

export async function runMetricStreamClickHouseSinkFromEnv(): Promise<void> {
  const client = createClickHouseClientFromEnv();
  if (!hasClickHouseInsertClient(client)) {
    throw new Error("ClickHouse metric-stream sink requires an insert-capable client");
  }

  const { consumer, topic } = createKafkaMetricStreamConsumerFromEnv(
    "metric-stream-clickhouse-sink",
  );

  await runMetricStreamEventConsumer({
    consumer,
    topic,
    handleEvents: async (events) => {
      await applyMetricStreamEventsToClickHouse(client, events);
    },
  });
}
