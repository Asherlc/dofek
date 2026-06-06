import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { type MetricStreamEventV1, metricStreamEventV1Schema } from "./events.ts";
import {
  createKafkaMetricStreamConsumerFromEnv,
  runMetricStreamEventConsumer,
} from "./redpanda-consumer.ts";

export interface ClickHouseMetricStreamInsertClient {
  insert(options: {
    table: "postgres_fitness.metric_stream";
    values: readonly ClickHouseMetricStreamRow[];
    format: "JSONEachRow";
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
  _peerdb_synced_at: string;
  _peerdb_is_deleted: 0;
  _peerdb_version: number;
}

function isClickHouseReplicatedEvent(event: MetricStreamEventV1): boolean {
  return event.channel !== "imu";
}

export function mapMetricStreamEventToClickHouseRow(
  event: MetricStreamEventV1,
): ClickHouseMetricStreamRow {
  const parsedEvent = metricStreamEventV1Schema.parse(event);
  return {
    recorded_at: parsedEvent.recordedAt,
    user_id: parsedEvent.userId,
    provider_id: parsedEvent.providerId,
    external_id: parsedEvent.externalId ?? null,
    device_id: parsedEvent.deviceId ?? null,
    source_type: parsedEvent.sourceType,
    channel: parsedEvent.channel,
    activity_id: parsedEvent.activityId ?? null,
    scalar: parsedEvent.scalar ?? null,
    point: parsedEvent.point ?? null,
    id: parsedEvent.id,
    _peerdb_synced_at: new Date().toISOString(),
    _peerdb_is_deleted: 0,
    _peerdb_version: 0,
  };
}

export async function insertMetricStreamEventsIntoClickHouse(
  client: ClickHouseMetricStreamInsertClient,
  events: readonly MetricStreamEventV1[],
): Promise<number> {
  const rows = events
    .map((event) => metricStreamEventV1Schema.parse(event))
    .filter(isClickHouseReplicatedEvent)
    .map(mapMetricStreamEventToClickHouseRow);

  if (rows.length === 0) {
    return 0;
  }

  await client.insert({
    table: "postgres_fitness.metric_stream",
    values: rows,
    format: "JSONEachRow",
  });

  return rows.length;
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
      await insertMetricStreamEventsIntoClickHouse(client, events);
    },
  });
}
