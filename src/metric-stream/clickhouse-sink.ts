import { createHash } from "node:crypto";
import type { Server } from "node:http";
import Pulsar, { type Client } from "pulsar-client";
import { z } from "zod";
import {
  coordinateAnalyticsDelivery,
  coordinateAnalyticsDeliveryGroup,
} from "../analytics/analytics-delivery.ts";
import { loadAnalyticsStreamState } from "../analytics/analytics-work-store.ts";
import { metricStreamPositionIdentity } from "../analytics/journal-position.ts";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { createDatabaseFromEnv, type Database } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";
import type { ClickHouseMetricStreamRow } from "./clickhouse-row.ts";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  ACCOUNT_ERASURE_OPERATION_FENCE_TABLE,
  METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_DELETE_SCOPE_TABLE,
  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_TABLE,
} from "./clickhouse-table.ts";
import type { MetricStreamConsumerBatchContext } from "./consumer-context.ts";
import {
  createMetricStreamConsumerReadinessServer,
  MetricStreamConsumerReadiness,
} from "./consumer-readiness.ts";
import {
  isMetricStreamBatchCompletedEvent,
  isMetricStreamDeletedEvent,
  type MetricStreamDeletedEventV3,
  type MetricStreamDeleteScope,
  type MetricStreamEventV1,
  type MetricStreamEventV2,
  type MetricStreamRedpandaEvent,
  type MetricStreamRowEvent,
} from "./events.ts";
import { runPulsarMetricStreamConsumer } from "./pulsar-consumer.ts";
import {
  applyMetricStreamSourceEffects,
  prepareMetricStreamSourceEffects,
} from "./source-effects.ts";
import {
  applyMetricStreamSourceEffectsGroup,
  prepareMetricStreamSourceEffectsGroup,
} from "./source-effects-group.ts";
import { compareMetricStreamPositions, metricStreamPositionSchema } from "./transport-position.ts";

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

const accountErasureOperationFenceRowsSchema = z.array(
  z.object({ operation_hash: z.string().length(64) }),
);

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

// Each scope can add seven HTTP parameters. Keep requests below ClickHouse's
// default 1,000-field limit, including the revision and client settings.
const MAX_METRIC_STREAM_DELETE_SCOPES_PER_WRITE = 100;

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
  if (deletes.length > MAX_METRIC_STREAM_DELETE_SCOPES_PER_WRITE) {
    for (
      let offset = 0;
      offset < deletes.length;
      offset += MAX_METRIC_STREAM_DELETE_SCOPES_PER_WRITE
    ) {
      await markMetricStreamDeleteCommandsInClickHouse(
        client,
        deletes.slice(offset, offset + MAX_METRIC_STREAM_DELETE_SCOPES_PER_WRITE),
      );
    }
    return;
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
  const scopedCandidates = candidatePredicates
    .map(
      (conditions, index) => `SELECT candidate_row.id AS id, toUInt16(${index}) AS scope_index
          FROM ${METRIC_STREAM_TABLE} AS candidate_row
          WHERE ${conditions.join(" AND ")}
          GROUP BY candidate_row.id`,
    )
    .join("\n          UNION ALL\n          ");
  const correlatedLatestPredicates = latestPredicates
    .map((conditions, index) => `(scope_index = ${index} AND ${conditions.join(" AND ")})`)
    .join(" OR ");

  if (operationRevision) {
    const scopes = deletes.map(({ scope }) => ({
      user_id: scope.userId ?? null,
      provider_id: scope.providerId ?? null,
      activity_id: scope.activityId ?? null,
      channel: scope.channel ?? null,
      external_id: scope.externalId ?? null,
      external_id_set: scope.externalId === undefined ? 0 : 1,
      recorded_at_start: scope.recordedAtStart ?? null,
      recorded_at_end: scope.recordedAtEnd ?? null,
      operation_revision: operationRevision,
    }));
    await client.command({
      query: `INSERT INTO ${METRIC_STREAM_DELETE_SCOPE_TABLE} FORMAT JSONEachRow\n${scopes.map((scope) => JSON.stringify(scope)).join("\n")}`,
      clickhouse_settings: { date_time_input_format: "best_effort" },
    });
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
        ${replacementVersionExpression} AS version,
        latest_row.13 AS generation
      FROM (
        SELECT DISTINCT id, latest_row
        FROM (
        SELECT
          metric_stream_row.id AS id,
          candidate_scope.scope_index AS scope_index,
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
        INNER JOIN (
          ${scopedCandidates}
        ) AS candidate_scope ON candidate_scope.id = metric_stream_row.id
        GROUP BY metric_stream_row.id, candidate_scope.scope_index
        )
        WHERE ${correlatedLatestPredicates}
      )
      WHERE latest_row.14 = 0
        AND lower(hex(SHA256(toString(latest_row.2)))) NOT IN (
          SELECT user_hash
          FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL
        )`,
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

async function keepMetricStreamOwnershipActive<T>(
  context: MetricStreamConsumerBatchContext,
  operation: () => Promise<T>,
): Promise<T> {
  let failure: unknown;
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending || failure) return;
    pending = context
      .assertActive()
      .catch((error: unknown) => {
        failure = error;
        captureException(error, {
          tags: { metricStreamConsumer: "clickhouse-sink", metricStreamFailure: "ownership" },
        });
      })
      .finally(() => {
        pending = undefined;
      });
  }, 3_000);
  const stop = async () => {
    clearInterval(timer);
    await pending;
  };
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    await stop();
    throw error;
  }
  await stop();
  if (failure) throw failure;
  return result;
}

export async function applyMetricStreamEventsToClickHouse(
  client: ClickHouseClient,
  events: readonly MetricStreamRedpandaEvent[],
  context: MetricStreamConsumerBatchContext,
  database: Database,
): Promise<number> {
  if (!client.insert)
    throw new Error("Metric-stream sink requires an insert-capable analytics journal client");
  if (
    context.positions.length !== events.length ||
    context.positions.some(
      (position) =>
        !metricStreamPositionSchema.safeParse(position).success ||
        position.topic !== context.topic ||
        position.partition !== context.partition,
    )
  )
    throw new Error(
      "Metric-stream delivery positions must align with every event and batch stream",
    );
  for (let index = 1; index < context.positions.length; index++) {
    const prior = context.positions[index - 1],
      current = context.positions[index];
    if (!prior || !current || compareMetricStreamPositions(prior, current) >= 0)
      throw new Error(
        "Metric-stream delivery positions must preserve strict native delivery order",
      );
  }
  let inserted = 0;
  for (let index = 0; index < events.length; ) {
    const event = events[index];
    if (!event) throw new Error("Metric-stream event is missing");
    const position = context.positions[index];
    if (!position) throw new Error("Metric-stream delivery position is missing");
    if (isMetricStreamRow(event)) {
      const members: {
        event: MetricStreamEventV1 | MetricStreamEventV2;
        position: typeof position;
      }[] = [];
      const seen = new Set<string>();
      while (index < events.length && members.length < 500) {
        const next = events[index],
          nextPosition = context.positions[index];
        if (!next || !nextPosition) throw new Error("Metric-stream group input is incomplete");
        if (!isMetricStreamRow(next) || seen.has(next.id.toLowerCase())) break;
        seen.add(next.id.toLowerCase());
        members.push({ event: next, position: nextPosition });
        index++;
      }
      const byPosition = new Map(
        members.map((member) => [metricStreamPositionIdentity(member.position), member]),
      );
      const inputs = (positions: readonly (typeof position)[], times: readonly string[]) => {
        if (positions.length !== times.length)
          throw new Error("Grouped ingestion times do not match native members");
        return positions.map((position, ordinal) => {
          const member = byPosition.get(metricStreamPositionIdentity(position)),
            ingestedAt = times[ordinal];
          if (!member || !ingestedAt)
            throw new Error("Grouped native member or ingestion time is missing");
          return { ...member, ingestedAt };
        });
      };
      await keepMetricStreamOwnershipActive(context, () =>
        coordinateAnalyticsDeliveryGroup(
          { database, clickhouse: client },
          {
            positions: members.map((member) => member.position),
            maximum: 500,
            assertActive: context.assertActive,
            prepare: (owner, positions, times) =>
              prepareMetricStreamSourceEffectsGroup(owner, inputs(positions, times)),
            apply: async (owner, positions, effects, times) => {
              inserted += await applyMetricStreamSourceEffectsGroup(
                owner,
                inputs(positions, times),
                effects,
              );
            },
          },
        ),
      );
      await context.assertActive();
      continue;
    }
    if (isMetricStreamBatchCompletedEvent(event) && position.transport !== "pulsar")
      throw new Error("Native processing marker requires a Pulsar position");
    await context.assertActive();
    await keepMetricStreamOwnershipActive(context, () =>
      coordinateAnalyticsDelivery(
        { database, clickhouse: client },
        {
          position,
          assertActive: context.assertActive,
          prepare: (owner) => prepareMetricStreamSourceEffects(owner, event, position),
          applyControl: async (owner) => {
            if (isMetricStreamDeletedEvent(event) && "operationRevision" in event) {
              const scope = event.scope;
              if (!owner.client.insert) throw new Error("Source owner requires insert");
              await owner.client.insert({
                table: METRIC_STREAM_DELETE_SCOPE_TABLE,
                format: "JSONEachRow",
                values: [
                  {
                    user_id: scope.userId ?? null,
                    provider_id: scope.providerId ?? null,
                    activity_id: scope.activityId ?? null,
                    channel: scope.channel ?? null,
                    external_id: scope.externalId ?? null,
                    external_id_set: scope.externalId === undefined ? 0 : 1,
                    recorded_at_start: scope.recordedAtStart ?? null,
                    recorded_at_end: scope.recordedAtEnd ?? null,
                    operation_revision: event.operationRevision,
                  },
                ],
                clickhouse_settings: { date_time_input_format: "best_effort" },
              });
            }
          },
          apply: async (owner, effects) => {
            inserted += await applyMetricStreamSourceEffects(owner, event, effects);
          },
          acknowledgeEffects: async (owner) => {
            if (isMetricStreamDeletedEvent(event) && "eventId" in event) {
              await owner.client.command({
                query: `INSERT INTO ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE} (event_id) VALUES ({eventId:UUID})`,
                query_params: { eventId: event.eventId },
              });
            }
            if (isMetricStreamBatchCompletedEvent(event)) {
              if (position.transport !== "pulsar")
                throw new Error("Native processing marker requires a Pulsar position");
              if (await isOperationAccountErasureFenced(owner.client, event.operationId)) return;
              await owner.client.command({
                query:
                  "INSERT INTO " +
                  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE +
                  " (operation_id,batch_id,dataset_keys,expected_event_count,topic,topic_partition,marker_offset,marker_transport,marker_epoch,marker_message_id)" +
                  " VALUES ({operation_id:UUID},{batch_id:String},{dataset_keys:Array(String)},{expected_event_count:UInt64},{topic:String},{partition:Int32},{marker_offset:Nullable(UInt64)},{marker_transport:String},{marker_epoch:Nullable(String)},{marker_message_id:Nullable(String)})",
                query_params: {
                  operation_id: event.operationId,
                  batch_id: event.batchId,
                  dataset_keys: event.datasetKeys,
                  expected_event_count: event.expectedEventCount,
                  topic: position.topic,
                  partition: position.partition,
                  marker_offset: null,
                  marker_transport: "pulsar",
                  marker_epoch: position.epoch,
                  marker_message_id: position.serializedMessageId,
                },
              });
            }
          },
        },
      ),
    );
    await context.assertActive();
    index++;
  }
  return inserted;
}

function isMetricStreamRow(event: MetricStreamRedpandaEvent): event is MetricStreamRowEvent {
  return !isMetricStreamDeletedEvent(event) && !isMetricStreamBatchCompletedEvent(event);
}
async function isOperationAccountErasureFenced(
  client: Pick<ClickHouseClient, "query">,
  operationId: string,
): Promise<boolean> {
  const result = await client.query({
    query:
      "SELECT operation_hash FROM " +
      ACCOUNT_ERASURE_OPERATION_FENCE_TABLE +
      " FINAL WHERE operation_hash={operation_hash:FixedString(64)} LIMIT 1",
    query_params: { operation_hash: createHash("sha256").update(operationId).digest("hex") },
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  return accountErasureOperationFenceRowsSchema.parse(await result.json()).length > 0;
}
function requiredSinkEnvironment(
  key:
    | "PULSAR_SERVICE_URL"
    | "METRIC_STREAM_TOPIC"
    | "METRIC_STREAM_TRANSPORT_EPOCH"
    | "METRIC_STREAM_SUBSCRIPTION",
): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}
export async function runMetricStreamClickHouseSinkFromEnv(
  readiness: MetricStreamConsumerReadiness,
): Promise<void> {
  const controller = new AbortController();
  const stop = () => {
    readiness.markUnavailable();
    controller.abort();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let database: Database | undefined;
  let client: ReturnType<typeof createClickHouseClientFromEnv> | undefined;
  let native: Client | undefined;
  let failed = false;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    const serviceUrl = requiredSinkEnvironment("PULSAR_SERVICE_URL");
    const topic = requiredSinkEnvironment("METRIC_STREAM_TOPIC");
    const epoch = requiredSinkEnvironment("METRIC_STREAM_TRANSPORT_EPOCH");
    const subscription = requiredSinkEnvironment("METRIC_STREAM_SUBSCRIPTION");
    if (!topic.startsWith("persistent://"))
      throw new Error("METRIC_STREAM_TOPIC must name one concrete persistent Pulsar topic");
    const db = createDatabaseFromEnv();
    database = db;
    const clickhouse = createClickHouseClientFromEnv();
    client = clickhouse;
    const pulsar = new Pulsar.Client({ serviceUrl });
    native = pulsar;
    const stream = { transport: "pulsar" as const, epoch, topic, partition: -1 };
    await runPulsarMetricStreamConsumer({
      client: pulsar,
      readiness,
      topic,
      epoch,
      partition: -1,
      subscription,
      receiverQueueSize: 20,
      nativeBatchMessages: 20,
      nativeBatchBytes: 8 * 1024 * 1024,
      maxGroupMessages: 500,
      maxGroupBytes: 8 * 1024 * 1024,
      signal: controller.signal,
      loadPendingGroup: async () =>
        (await loadAnalyticsStreamState(db, stream))?.pendingGroup ?? null,
      handleEvents: async (events, context) => {
        await applyMetricStreamEventsToClickHouse(clickhouse, events, context, db);
      },
    });
  } catch (error) {
    failed = true;
    failure = error;
    captureException(error, {
      tags: { metricStreamConsumer: "clickhouse-sink", metricStreamFailure: "runtime" },
    });
  } finally {
    readiness.markUnavailable();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    const closing: Promise<unknown>[] = [];
    const ownedNative = native,
      ownedClient = client,
      ownedDatabase = database;
    if (ownedNative) closing.push(Promise.resolve().then(() => ownedNative.close()));
    if (ownedClient) closing.push(Promise.resolve().then(() => ownedClient.close()));
    if (ownedDatabase) closing.push(Promise.resolve().then(() => ownedDatabase.$client.end()));
    const outcomes = await Promise.allSettled(closing);
    for (const result of outcomes)
      if (result.status === "rejected") {
        cleanupErrors.push(result.reason);
        captureException(result.reason, {
          tags: { metricStreamConsumer: "clickhouse-sink", metricStreamFailure: "cleanup" },
        });
      }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failed ? [failure, ...cleanupErrors] : cleanupErrors,
      "Metric-stream sink and cleanup failed",
    );
  if (failed) throw failure;
}
export async function startMetricStreamClickHouseSinkFromEnv(): Promise<void> {
  const readiness = new MetricStreamConsumerReadiness();
  const server = createMetricStreamConsumerReadinessServer(readiness);
  let failed = false;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await listenReadinessServer(server);
    server.unref();
    await runMetricStreamClickHouseSinkFromEnv(readiness);
  } catch (error) {
    failed = true;
    failure = error;
    captureException(error, {
      tags: { metricStreamConsumer: "clickhouse-sink", metricStreamFailure: "readiness" },
    });
  } finally {
    readiness.markUnavailable();
    if (server.listening) {
      try {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        captureException(error, {
          tags: { metricStreamConsumer: "clickhouse-sink", metricStreamFailure: "readiness-close" },
        });
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failed ? [failure, ...cleanupErrors] : cleanupErrors,
      "Metric-stream sink and readiness close failed",
    );
  if (failed) throw failure;
}
