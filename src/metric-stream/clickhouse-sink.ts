import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import {
  METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_TABLE,
  PROVIDER_DATA_GENERATION_TABLE,
} from "./clickhouse-table.ts";
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
  query?(options: {
    query: string;
    query_params?: Record<string, unknown>;
    format: "JSONEachRow";
  }): Promise<{ json(): Promise<unknown> }>;
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
  generation: number;
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
    generation: event.generation,
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

const providerDataGenerationRowsSchema = z.array(
  z.object({
    generation: z.coerce.number().int().nonnegative(),
    provider_id: z.string().min(1),
    user_id: z.uuid(),
  }),
);

function providerGenerationKey(userId: string, providerId: string): string {
  return `${userId}\0${providerId}`;
}

async function filterEventsByProviderGeneration(
  client: ClickHouseMetricStreamInsertClient,
  events: readonly MetricStreamEventV1[],
): Promise<MetricStreamEventV1[]> {
  if (events.length === 0) return [];
  if (!client.query) {
    throw new Error("ClickHouse metric-stream ingestion requires a query-capable client");
  }

  const providerScopes = new Map<string, { providerId: string; userId: string }>();
  for (const event of events) {
    providerScopes.set(providerGenerationKey(event.userId, event.providerId), {
      providerId: event.providerId,
      userId: event.userId,
    });
  }

  const queryParams: Record<string, unknown> = {};
  const predicates = [...providerScopes.values()].map((scope, index) => {
    queryParams[`user_id_${index}`] = scope.userId;
    queryParams[`provider_id_${index}`] = scope.providerId;
    return `(user_id = {user_id_${index}:UUID} AND provider_id = {provider_id_${index}:String})`;
  });
  const result = await client.query({
    query: `SELECT user_id, provider_id, max(generation) AS generation
      FROM ${PROVIDER_DATA_GENERATION_TABLE}
      WHERE ${predicates.join(" OR ")}
      GROUP BY user_id, provider_id`,
    query_params: queryParams,
    format: "JSONEachRow",
  });
  const activeGenerations = new Map<string, number>();
  for (const row of providerDataGenerationRowsSchema.parse(await result.json())) {
    activeGenerations.set(providerGenerationKey(row.user_id, row.provider_id), row.generation);
  }

  return events.filter(
    (event) =>
      event.generation >=
      (activeGenerations.get(providerGenerationKey(event.userId, event.providerId)) ?? 0),
  );
}

async function tombstoneMetricStreamIds(
  client: ClickHouseMetricStreamInsertClient,
  rowIds: readonly string[],
): Promise<void> {
  if (rowIds.length === 0) return;
  if (!client.command) {
    throw new Error(
      "ClickHouse metric-stream generation fencing requires a command-capable client",
    );
  }
  await client.command({
    query: `INSERT INTO ${METRIC_STREAM_TABLE} (
        id, activity_id, user_id, recorded_at, channel, provider_id, external_id,
        device_id, source_type, scalar, vector, point, metadata, ingested_at,
        is_deleted, version, generation
      )
      SELECT
        id,
        latest_row.1 AS activity_id,
        latest_row.2 AS user_id,
        latest_row.3 AS recorded_at,
        latest_row.4 AS channel,
        latest_row.5 AS provider_id,
        latest_row.6 AS external_id,
        latest_row.7 AS device_id,
        latest_row.8 AS source_type,
        latest_row.9 AS scalar,
        latest_row.10 AS vector,
        latest_row.11 AS point,
        latest_row.12 AS metadata,
        now64(9) AS ingested_at,
        1 AS is_deleted,
        greatest(latest_row.15 + 1, {delete_version:Int64}) AS version,
        latest_row.13 AS generation
      FROM (
        SELECT
          id,
          argMax(
            tuple(
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
              generation,
              is_deleted,
              version
            ),
            tuple(version, ingested_at)
          ) AS latest_row
        FROM ${METRIC_STREAM_TABLE}
        WHERE id IN {row_ids:Array(UUID)}
        GROUP BY id
      )
      WHERE latest_row.14 = 0`,
    query_params: {
      delete_version: Date.now(),
      row_ids: rowIds,
    },
  });
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

interface ClickHouseDeleteScopeColumnExpressions {
  activityId: string;
  channel: string;
  externalId: string;
  providerId: string;
  recordedAt: string;
  userId: string;
}

const candidateDeleteScopeColumns = {
  activityId: "candidate_row.activity_id",
  channel: "candidate_row.channel",
  externalId: "candidate_row.external_id",
  providerId: "candidate_row.provider_id",
  recordedAt: "candidate_row.recorded_at",
  userId: "candidate_row.user_id",
} satisfies ClickHouseDeleteScopeColumnExpressions;

const latestDeleteScopeColumns = {
  activityId: "latest_row.1",
  channel: "latest_row.4",
  externalId: "latest_row.6",
  providerId: "latest_row.5",
  recordedAt: "latest_row.3",
  userId: "latest_row.2",
} satisfies ClickHouseDeleteScopeColumnExpressions;

function clickHouseDeleteScopeConditions(
  scope: MetricStreamDeleteScope,
  queryParams: Record<string, unknown>,
  columns: ClickHouseDeleteScopeColumnExpressions,
): string[] {
  const conditions: string[] = [];
  if (scope.userId) {
    queryParams.user_id = scope.userId;
    conditions.push(`${columns.userId} = {user_id:UUID}`);
  }
  if (scope.providerId) {
    queryParams.provider_id = scope.providerId;
    conditions.push(`${columns.providerId} = {provider_id:String}`);
  }
  if (scope.externalId === null) {
    conditions.push(`${columns.externalId} IS NULL`);
  } else if (scope.externalId !== undefined) {
    queryParams.external_id = scope.externalId;
    conditions.push(`${columns.externalId} = {external_id:String}`);
  }
  if (scope.channel) {
    queryParams.channel = scope.channel;
    conditions.push(`${columns.channel} = {channel:String}`);
  }
  if (scope.activityId) {
    queryParams.activity_id = scope.activityId;
    conditions.push(`${columns.activityId} = {activity_id:UUID}`);
  }
  if (scope.recordedAtStart) {
    queryParams.recorded_at_start = scope.recordedAtStart;
    conditions.push(
      `${columns.recordedAt} >= parseDateTime64BestEffort({recorded_at_start:String})`,
    );
  }
  if (scope.recordedAtEnd) {
    queryParams.recorded_at_end = scope.recordedAtEnd;
    conditions.push(`${columns.recordedAt} < parseDateTime64BestEffort({recorded_at_end:String})`);
  }
  if (conditions.length === 0) {
    throw new Error("Metric stream delete scope produced no ClickHouse conditions");
  }
  return conditions;
}

export async function markMetricStreamScopeDeletedInClickHouse(
  client: ClickHouseMetricStreamInsertClient,
  scope: MetricStreamDeleteScope,
  eventId?: string,
): Promise<void> {
  if (!client.command) {
    throw new Error("ClickHouse metric-stream deletion requires a command-capable client");
  }
  const queryParams: Record<string, unknown> = {
    delete_version: Date.now(),
  };
  const candidateConditions = clickHouseDeleteScopeConditions(
    scope,
    queryParams,
    candidateDeleteScopeColumns,
  );
  const latestConditions = clickHouseDeleteScopeConditions(
    scope,
    queryParams,
    latestDeleteScopeColumns,
  );
  await client.command({
    query: `INSERT INTO ${METRIC_STREAM_TABLE} (
        id, activity_id, user_id, recorded_at, channel, provider_id, external_id,
        device_id, source_type, scalar, vector, point, metadata, ingested_at,
        is_deleted, version, generation
      )
      SELECT
        id,
        latest_row.1 AS activity_id,
        latest_row.2 AS user_id,
        latest_row.3 AS recorded_at,
        latest_row.4 AS channel,
        latest_row.5 AS provider_id,
        latest_row.6 AS external_id,
        latest_row.7 AS device_id,
        latest_row.8 AS source_type,
        latest_row.9 AS scalar,
        latest_row.10 AS vector,
        latest_row.11 AS point,
        latest_row.12 AS metadata,
        now64(9) AS ingested_at,
        1 AS is_deleted,
        greatest(latest_row.15 + 1, {delete_version:Int64}) AS version,
        latest_row.13 AS generation
      FROM (
        SELECT
          metric_stream_row.id AS id,
          argMax(
            tuple(
              metric_stream_row.activity_id,
              metric_stream_row.user_id,
              metric_stream_row.recorded_at,
              metric_stream_row.channel,
              metric_stream_row.provider_id,
              metric_stream_row.external_id,
              metric_stream_row.device_id,
              metric_stream_row.source_type,
              metric_stream_row.scalar,
              metric_stream_row.vector,
              metric_stream_row.point,
              metric_stream_row.metadata,
              metric_stream_row.generation,
              metric_stream_row.is_deleted,
              metric_stream_row.version
            ),
            tuple(metric_stream_row.version, metric_stream_row.ingested_at)
          ) AS latest_row
        FROM ${METRIC_STREAM_TABLE} AS metric_stream_row
        WHERE metric_stream_row.id IN (
          SELECT candidate_row.id
          FROM ${METRIC_STREAM_TABLE} AS candidate_row
          WHERE ${candidateConditions.join(" AND ")}
          GROUP BY candidate_row.id
        )
        GROUP BY metric_stream_row.id
      )
      WHERE latest_row.14 = 0
        AND ${latestConditions.join(" AND ")}`,
    query_params: queryParams,
  });
  if (eventId) {
    await client.command({
      query: `INSERT INTO ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE} (event_id)
        VALUES ({event_id:UUID})`,
      query_params: { event_id: eventId },
    });
  }
}

export async function applyMetricStreamEventsToClickHouse(
  client: ClickHouseMetricStreamInsertClient,
  events: readonly MetricStreamRedpandaEvent[],
): Promise<number> {
  let inserted = 0;
  let rowBuffer: MetricStreamEventV1[] = [];
  const flushRows = async () => {
    if (rowBuffer.length === 0) return;
    const replicatedEvents = rowBuffer.filter(isClickHouseReplicatedEvent);
    await insertMetricStreamEventsIntoClickHouse(client, replicatedEvents);
    const currentGenerationEvents = await filterEventsByProviderGeneration(
      client,
      replicatedEvents,
    );
    const currentEventIds = new Set(currentGenerationEvents.map((event) => event.id));
    const staleEventIds = [
      ...new Set(
        replicatedEvents.filter((event) => !currentEventIds.has(event.id)).map((event) => event.id),
      ),
    ];
    await tombstoneMetricStreamIds(client, staleEventIds);
    inserted += currentGenerationEvents.length;
    rowBuffer = [];
  };

  for (const event of events) {
    if (isMetricStreamDeletedEvent(event)) {
      await flushRows();
      await markMetricStreamScopeDeletedInClickHouse(
        client,
        event.scope,
        "eventId" in event ? event.eventId : undefined,
      );
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
