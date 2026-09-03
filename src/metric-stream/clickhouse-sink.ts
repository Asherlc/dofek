import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { captureException } from "../lib/error-reporting.ts";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  ACCOUNT_ERASURE_OPERATION_FENCE_TABLE,
  METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_TABLE,
  PROVIDER_DATA_GENERATION_TABLE,
} from "./clickhouse-table.ts";
import {
  createMetricStreamConsumerReadinessServer,
  MetricStreamConsumerReadiness,
} from "./consumer-readiness.ts";
import {
  isMetricStreamBatchCompletedEvent,
  isMetricStreamDeletedEvent,
  type MetricStreamBatchCompletedEventV1,
  type MetricStreamDeletedEventV3,
  type MetricStreamDeleteScope,
  type MetricStreamRedpandaEvent,
  type MetricStreamRowEvent,
} from "./events.ts";
import {
  createKafkaMetricStreamConsumerFromEnv,
  type MetricStreamConsumerBatchContext,
  runMetricStreamEventConsumer,
} from "./redpanda-consumer.ts";

export interface ClickHouseMetricStreamInsertClient {
  command?(options: {
    query: string;
    query_params?: Record<string, unknown>;
    clickhouse_settings?: Record<string, string | number | boolean>;
  }): Promise<unknown>;
  query?(options: {
    query: string;
    query_params?: Record<string, unknown>;
    format: "JSONEachRow";
    clickhouse_settings?: Record<string, string | number | boolean>;
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
  version: number | string;
}

const MAX_METRIC_STREAM_ROWS_PER_WRITE = 1_000;
const METRIC_STREAM_HEARTBEAT_INTERVAL_MS = 3_000;

function isClickHouseReplicatedEvent(event: MetricStreamRowEvent): boolean {
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
  event: MetricStreamRowEvent,
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
    version: event.version === 1 ? 0 : (BigInt(event.operationRevision) * 2n + 1n).toString(),
  };
}

async function keepMetricStreamHeartbeatAlive<T>(
  context: MetricStreamConsumerBatchContext | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!context) {
    return operation();
  }

  let heartbeatFailure: unknown;
  let heartbeatInFlight: Promise<void> | undefined;
  const heartbeat = (): void => {
    if (heartbeatInFlight || heartbeatFailure) {
      return;
    }
    heartbeatInFlight = context
      .heartbeat()
      .catch((error: unknown) => {
        heartbeatFailure = error;
        captureException(error, {
          tags: {
            metricStreamConsumer: "clickhouse-sink",
            metricStreamFailure: "heartbeat",
          },
        });
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  };
  const timer = setInterval(heartbeat, METRIC_STREAM_HEARTBEAT_INTERVAL_MS);
  const stopHeartbeat = async (): Promise<void> => {
    clearInterval(timer);
    await heartbeatInFlight;
  };

  try {
    const result = await operation();
    await stopHeartbeat();
    if (heartbeatFailure) {
      throw heartbeatFailure;
    }
    return result;
  } catch (error) {
    await stopHeartbeat();
    throw error;
  }
}

const providerDataGenerationRowsSchema = z.array(
  z.object({
    generation: z.coerce.number().int().nonnegative(),
    provider_id: z.string().min(1),
    user_id: z.uuid(),
  }),
);
const deletionAcknowledgementRowsSchema = z.array(
  z.object({ acknowledgement_count: z.coerce.number().int().nonnegative() }),
);
const accountErasureFenceRowsSchema = z.array(z.object({ user_hash: z.string().length(64) }));
const accountErasureOperationFenceRowsSchema = z.array(
  z.object({ operation_hash: z.string().length(64) }),
);

function providerGenerationKey(userId: string, providerId: string): string {
  return `${userId}\0${providerId}`;
}

async function isMetricStreamDeletionAcknowledged(
  client: ClickHouseMetricStreamInsertClient,
  eventId: string,
): Promise<boolean> {
  if (!client.query) return false;
  const result = await client.query({
    query: `SELECT 1 AS acknowledgement_count
      FROM ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE}
      WHERE event_id = {event_id:UUID}
      LIMIT 1`,
    query_params: { event_id: eventId },
    format: "JSONEachRow",
  });
  return deletionAcknowledgementRowsSchema
    .parse(await result.json())
    .some((row) => row.acknowledgement_count > 0);
}

async function filterEventsByProviderGeneration(
  client: ClickHouseMetricStreamInsertClient,
  events: readonly MetricStreamRowEvent[],
): Promise<MetricStreamRowEvent[]> {
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

async function filterEventsByAccountErasureFence(
  client: ClickHouseMetricStreamInsertClient,
  events: readonly MetricStreamRowEvent[],
): Promise<MetricStreamRowEvent[]> {
  if (events.length === 0) return [];
  if (!client.query) {
    throw new Error("ClickHouse metric-stream ingestion requires a query-capable client");
  }
  const userHashes = new Map<string, string>();
  for (const event of events) {
    userHashes.set(event.userId, createHash("sha256").update(event.userId).digest("hex"));
  }
  const result = await client.query({
    query: `SELECT user_hash
      FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL
      WHERE user_hash IN {user_hashes:Array(String)}`,
    query_params: {
      user_hashes: [...userHashes.values()],
    },
    format: "JSONEachRow",
  });
  const erasedUserHashes = new Set(
    accountErasureFenceRowsSchema.parse(await result.json()).map((row) => row.user_hash),
  );
  return events.filter((event) => !erasedUserHashes.has(userHashes.get(event.userId) ?? ""));
}

async function isOperationAccountErasureFenced(
  client: ClickHouseMetricStreamInsertClient,
  operationId: string,
): Promise<boolean> {
  if (!client.query) {
    throw new Error(
      "ClickHouse metric-stream processing acknowledgement requires a query-capable client",
    );
  }
  const operationHash = createHash("sha256").update(operationId).digest("hex");
  const result = await client.query({
    query: `SELECT operation_hash
      FROM ${ACCOUNT_ERASURE_OPERATION_FENCE_TABLE} FINAL
      WHERE operation_hash = {operation_hash:FixedString(64)}
      LIMIT 1`,
    query_params: { operation_hash: operationHash },
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  return accountErasureOperationFenceRowsSchema.parse(await result.json()).length > 0;
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
        latest_row.15 + 1 AS version,
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
      row_ids: rowIds,
    },
  });
}

export async function insertMetricStreamEventsIntoClickHouse(
  client: ClickHouseMetricStreamInsertClient,
  events: readonly MetricStreamRowEvent[],
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
  parameterSuffix = "",
): string[] {
  const conditions: string[] = [];
  const parameterName = (name: string) => `${name}${parameterSuffix}`;
  if (scope.userId) {
    queryParams[parameterName("user_id")] = scope.userId;
    conditions.push(`${columns.userId} = {${parameterName("user_id")}:UUID}`);
  }
  if (scope.providerId) {
    queryParams[parameterName("provider_id")] = scope.providerId;
    conditions.push(`${columns.providerId} = {${parameterName("provider_id")}:String}`);
  }
  if (scope.externalId === null) {
    conditions.push(`${columns.externalId} IS NULL`);
  } else if (scope.externalId !== undefined) {
    queryParams[parameterName("external_id")] = scope.externalId;
    conditions.push(`${columns.externalId} = {${parameterName("external_id")}:String}`);
  }
  if (scope.channel) {
    queryParams[parameterName("channel")] = scope.channel;
    conditions.push(`${columns.channel} = {${parameterName("channel")}:String}`);
  }
  if (scope.activityId) {
    queryParams[parameterName("activity_id")] = scope.activityId;
    conditions.push(`${columns.activityId} = {${parameterName("activity_id")}:UUID}`);
  }
  if (scope.recordedAtStart) {
    queryParams[parameterName("recorded_at_start")] = scope.recordedAtStart;
    conditions.push(
      `${columns.recordedAt} >= parseDateTime64BestEffort({${parameterName("recorded_at_start")}:String})`,
    );
  }
  if (scope.recordedAtEnd) {
    queryParams[parameterName("recorded_at_end")] = scope.recordedAtEnd;
    conditions.push(
      `${columns.recordedAt} < parseDateTime64BestEffort({${parameterName("recorded_at_end")}:String})`,
    );
  }
  if (conditions.length === 0) {
    throw new Error("Metric stream delete scope produced no ClickHouse conditions");
  }
  return conditions;
}

interface MetricStreamDeleteCommand {
  eventId?: string;
  operationRevision?: string;
  scope: MetricStreamDeleteScope;
}

async function markMetricStreamDeleteCommandsInClickHouse(
  client: Pick<ClickHouseMetricStreamInsertClient, "command">,
  deletes: readonly MetricStreamDeleteCommand[],
): Promise<void> {
  if (deletes.length === 0) {
    return;
  }
  if (!client.command) {
    throw new Error("ClickHouse metric-stream deletion requires a command-capable client");
  }
  const operationRevision = deletes[0]?.operationRevision;
  if (deletes.some((event) => event.operationRevision !== operationRevision)) {
    throw new Error("ClickHouse metric-stream deletion batch requires one operation revision");
  }
  const queryParams: Record<string, unknown> = {};
  const replacementVersionExpression = operationRevision
    ? "{replacement_version:UInt64}"
    : "latest_row.15 + 1";
  if (operationRevision) {
    queryParams.replacement_version = (BigInt(operationRevision) * 2n).toString();
  }
  const isBatch = deletes.length > 1;
  const candidatePredicates = deletes.map((event, index) =>
    clickHouseDeleteScopeConditions(
      event.scope,
      queryParams,
      candidateDeleteScopeColumns,
      isBatch ? `_${index}` : "",
    ),
  );
  const latestPredicates = deletes.map((event, index) =>
    clickHouseDeleteScopeConditions(
      event.scope,
      queryParams,
      latestDeleteScopeColumns,
      isBatch ? `_${index}` : "",
    ),
  );
  const renderPredicates = (predicates: readonly string[][]) =>
    predicates.map((conditions) => `(${conditions.join(" AND ")})`).join(" OR ");

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
        ${replacementVersionExpression} AS version,
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
          WHERE ${renderPredicates(candidatePredicates)}
          GROUP BY candidate_row.id
        )
        GROUP BY metric_stream_row.id
      )
      WHERE latest_row.14 = 0
        AND lower(hex(SHA256(toString(latest_row.2)))) NOT IN (
          SELECT user_hash
          FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL
        )
        AND (${renderPredicates(latestPredicates)})`,
    query_params: queryParams,
  });
  for (const { eventId } of deletes) {
    if (eventId) {
      await client.command({
        query: `INSERT INTO ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE} (event_id)
          VALUES ({event_id:UUID})`,
        query_params: { event_id: eventId },
      });
    }
  }
}

export async function markMetricStreamScopesDeletedInClickHouse(
  client: Pick<ClickHouseMetricStreamInsertClient, "command">,
  events: readonly MetricStreamDeletedEventV3[],
): Promise<void> {
  await markMetricStreamDeleteCommandsInClickHouse(client, events);
}

export async function markMetricStreamScopeDeletedInClickHouse(
  client: ClickHouseMetricStreamInsertClient,
  scope: MetricStreamDeleteScope,
  eventId?: string,
  operationRevision?: string,
): Promise<void> {
  await markMetricStreamDeleteCommandsInClickHouse(client, [{ scope, eventId, operationRevision }]);
}

export async function applyMetricStreamEventsToClickHouse(
  client: ClickHouseMetricStreamInsertClient,
  events: readonly MetricStreamRedpandaEvent[],
  context?: MetricStreamConsumerBatchContext,
): Promise<number> {
  let inserted = 0;
  let rowBuffer: MetricStreamRowEvent[] = [];
  const heartbeat = async (): Promise<void> => {
    if (context) {
      await context.heartbeat();
    }
  };
  const flushRows = async () => {
    if (rowBuffer.length > 0) {
      await keepMetricStreamHeartbeatAlive(context, async () => {
        const replicatedEvents = rowBuffer.filter(isClickHouseReplicatedEvent);
        const accountActiveEvents = await filterEventsByAccountErasureFence(
          client,
          replicatedEvents,
        );
        await insertMetricStreamEventsIntoClickHouse(client, accountActiveEvents);
        const currentGenerationEvents = await filterEventsByProviderGeneration(
          client,
          accountActiveEvents,
        );
        const currentEventIds = new Set(currentGenerationEvents.map((event) => event.id));
        const staleEventIds = [
          ...new Set(
            accountActiveEvents
              .filter((event) => !currentEventIds.has(event.id))
              .map((event) => event.id),
          ),
        ];
        await tombstoneMetricStreamIds(client, staleEventIds);
        inserted += currentGenerationEvents.length;
        rowBuffer = [];
      });
      await heartbeat();
    }
  };

  const acknowledgeProcessingBatch = async (
    event: MetricStreamBatchCompletedEventV1,
    eventIndex: number,
  ): Promise<void> => {
    if (!context) {
      throw new Error("metric-stream processing marker requires Kafka batch context");
    }
    const markerOffset = context.eventOffsets[eventIndex];
    if (markerOffset === undefined) {
      throw new Error("metric-stream processing marker is missing its Kafka offset");
    }
    if (!client.command) {
      throw new Error(
        "ClickHouse metric-stream processing acknowledgement requires a command-capable client",
      );
    }
    if (await isOperationAccountErasureFenced(client, event.operationId)) {
      return;
    }
    await client.command({
      query: `INSERT INTO ${METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE} (
          operation_id,
          batch_id,
          dataset_keys,
          expected_event_count,
          topic,
          topic_partition,
          marker_offset
        ) VALUES (
          {operation_id:UUID},
          {batch_id:String},
          {dataset_keys:Array(String)},
          {expected_event_count:UInt64},
          {topic:String},
          {partition:Int32},
          {marker_offset:UInt64}
        )`,
      query_params: {
        operation_id: event.operationId,
        batch_id: event.batchId,
        dataset_keys: event.datasetKeys,
        expected_event_count: event.expectedEventCount,
        topic: context.topic,
        partition: context.partition,
        marker_offset: markerOffset,
      },
    });
  };

  let eventIndex = 0;
  while (eventIndex < events.length) {
    const event = events[eventIndex];
    if (!event) {
      break;
    }
    if (isMetricStreamBatchCompletedEvent(event)) {
      await flushRows();
      await heartbeat();
      await keepMetricStreamHeartbeatAlive(context, () =>
        acknowledgeProcessingBatch(event, eventIndex),
      );
      await heartbeat();
      eventIndex += 1;
      continue;
    }
    if (isMetricStreamDeletedEvent(event)) {
      await flushRows();
      await heartbeat();
      if ("operationRevision" in event) {
        const deleteRun: MetricStreamDeletedEventV3[] = [];
        let nextEventIndex = eventIndex;
        while (nextEventIndex < events.length) {
          const candidate = events[nextEventIndex];
          if (
            !candidate ||
            !isMetricStreamDeletedEvent(candidate) ||
            !("operationRevision" in candidate) ||
            candidate.operationRevision !== event.operationRevision
          ) {
            break;
          }
          deleteRun.push(candidate);
          nextEventIndex += 1;
        }
        const unacknowledgedDeletes: MetricStreamDeletedEventV3[] = [];
        for (const deleteEvent of deleteRun) {
          const acknowledged = await keepMetricStreamHeartbeatAlive(context, () =>
            isMetricStreamDeletionAcknowledged(client, deleteEvent.eventId),
          );
          if (!acknowledged) {
            unacknowledgedDeletes.push(deleteEvent);
          }
          await heartbeat();
        }
        await keepMetricStreamHeartbeatAlive(context, () =>
          markMetricStreamScopesDeletedInClickHouse(client, unacknowledgedDeletes),
        );
        await heartbeat();
        eventIndex = nextEventIndex;
        continue;
      }
      if (
        "eventId" in event &&
        (await keepMetricStreamHeartbeatAlive(context, () =>
          isMetricStreamDeletionAcknowledged(client, event.eventId),
        ))
      ) {
        await heartbeat();
        eventIndex += 1;
        continue;
      }
      await keepMetricStreamHeartbeatAlive(context, () =>
        markMetricStreamScopeDeletedInClickHouse(
          client,
          event.scope,
          "eventId" in event ? event.eventId : undefined,
          undefined,
        ),
      );
      await heartbeat();
      eventIndex += 1;
      continue;
    }
    rowBuffer.push(event);
    if (rowBuffer.length >= MAX_METRIC_STREAM_ROWS_PER_WRITE) {
      await flushRows();
    }
    eventIndex += 1;
  }

  await flushRows();
  return inserted;
}

function hasClickHouseInsertClient(
  client: ClickHouseClient,
): client is ClickHouseClient & ClickHouseMetricStreamInsertClient {
  return typeof client.insert === "function";
}

export async function runMetricStreamClickHouseSinkFromEnv(
  readiness: MetricStreamConsumerReadiness,
): Promise<void> {
  const client = createClickHouseClientFromEnv();
  if (!hasClickHouseInsertClient(client)) {
    throw new Error("ClickHouse metric-stream sink requires an insert-capable client");
  }

  const { consumer, quarantine, topic } = createKafkaMetricStreamConsumerFromEnv(
    "metric-stream-clickhouse-sink",
  );
  if (!consumer.observeGroupLifecycle) {
    throw new Error("ClickHouse metric-stream sink requires Kafka group lifecycle events");
  }
  await runMetricStreamEventConsumer({
    consumer,
    quarantine,
    topic,
    lifecycleListener: readiness,
    handleEvents: async (events, context) => {
      await applyMetricStreamEventsToClickHouse(client, events, context);
    },
  });
}

export async function startMetricStreamClickHouseSinkFromEnv(): Promise<void> {
  const readiness = new MetricStreamConsumerReadiness();
  const readinessServer = createMetricStreamConsumerReadinessServer(readiness);
  await listenReadinessServer(readinessServer);
  readinessServer.unref();
  await runMetricStreamClickHouseSinkFromEnv(readiness);
}

function listenReadinessServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(3001, "0.0.0.0");
  });
}
