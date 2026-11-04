import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { z } from "zod";
import { coordinateAnalyticsDelivery } from "../analytics/analytics-delivery.ts";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { createDatabaseFromEnv, type Database } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";
import {
  ACCOUNT_ERASURE_OPERATION_FENCE_TABLE,
  METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_DELETE_SCOPE_TABLE,
  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE,
} from "./clickhouse-table.ts";
import type { MetricStreamConsumerBatchContext } from "./consumer-context.ts";
import {
  createMetricStreamConsumerReadinessServer,
  MetricStreamConsumerReadiness,
} from "./consumer-readiness.ts";
import {
  isMetricStreamBatchCompletedEvent,
  isMetricStreamDeletedEvent,
  isMetricStreamProviderGenerationDeletedEvent,
  type MetricStreamRedpandaEvent,
} from "./events.ts";
import {
  acknowledgeProviderDeletionCommand,
  advanceProviderDeletionFence,
  isProviderDeletionAccountErased,
  readProviderDeletionAcknowledgement,
} from "./provider-generation-deletion.ts";
import {
  createKafkaMetricStreamConsumerFromEnv,
  runMetricStreamEventConsumer,
} from "./redpanda-consumer.ts";
import {
  applyMetricStreamSourceEffects,
  prepareMetricStreamSourceEffects,
} from "./source-effects.ts";
import { compareMetricStreamPositions, metricStreamPositionSchema } from "./transport-position.ts";

async function keepMetricStreamHeartbeatAlive<T>(
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
          tags: { metricStreamConsumer: "clickhouse-sink", metricStreamFailure: "heartbeat" },
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
  if (!context || !database)
    throw new Error("Metric-stream sink requires typed delivery context and analytics journal");
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
  for (const [index, event] of events.entries()) {
    const position = context.positions[index];
    if (!position) throw new Error("Metric-stream delivery position is missing");
    if (isMetricStreamBatchCompletedEvent(event) && position.transport !== "kafka")
      throw new Error("Native processing marker schema has not been installed");
    await context.assertActive();
    await keepMetricStreamHeartbeatAlive(context, () =>
      coordinateAnalyticsDelivery(
        { database, clickhouse: client },
        {
          position,
          assertActive: context.assertActive,
          prepare: (owner) => prepareMetricStreamSourceEffects(owner, event, position),
          applyControl: async (owner) => {
            if (isMetricStreamProviderGenerationDeletedEvent(event)) {
              if (await isProviderDeletionAccountErased(owner.client, event)) return;
              if (!(await readProviderDeletionAcknowledgement(owner.client, event)))
                await advanceProviderDeletionFence(owner.client, event, owner.ingestedAt);
            }
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
            if (isMetricStreamProviderGenerationDeletedEvent(event))
              await acknowledgeProviderDeletionCommand(owner.client, event, position);
            if (isMetricStreamDeletedEvent(event) && "eventId" in event) {
              await owner.client.command({
                query: `INSERT INTO ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE} (event_id) VALUES ({eventId:UUID})`,
                query_params: { eventId: event.eventId },
              });
            }
            if (isMetricStreamBatchCompletedEvent(event)) {
              if (position.transport !== "kafka")
                throw new Error("Native processing marker schema has not been installed");
              const fence = await owner.client.query({
                query: `SELECT operation_hash FROM ${ACCOUNT_ERASURE_OPERATION_FENCE_TABLE} FINAL WHERE operation_hash={hash:String} LIMIT 1`,
                query_params: {
                  hash: createHash("sha256").update(event.operationId).digest("hex"),
                },
                format: "JSONEachRow",
                clickhouse_settings: { log_queries: 0 },
              });
              if (
                z.array(z.object({ operation_hash: z.string() })).parse(await fence.json()).length
              )
                return;
              await owner.client.command({
                query: `INSERT INTO ${METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE}
              (operation_id,batch_id,dataset_keys,expected_event_count,topic,topic_partition,marker_offset)
              VALUES ({operation:UUID},{batch:String},{datasets:Array(String)},{count:UInt64},{topic:String},{partition:Int32},{offset:UInt64})`,
                query_params: {
                  operation: event.operationId,
                  batch: event.batchId,
                  datasets: event.datasetKeys,
                  count: event.expectedEventCount,
                  topic: position.topic,
                  partition: position.partition,
                  offset: position.offset,
                },
              });
            }
          },
        },
      ),
    );
    await context.assertActive();
  }
  return inserted;
}

export async function runMetricStreamClickHouseSinkFromEnv(
  readiness: MetricStreamConsumerReadiness,
): Promise<void> {
  const client = createClickHouseClientFromEnv();
  if (!client.insert)
    throw new Error("ClickHouse metric-stream sink requires an insert-capable client");
  const { consumer, quarantine, topic, epoch } = createKafkaMetricStreamConsumerFromEnv();
  if (!consumer.observeGroupLifecycle)
    throw new Error("ClickHouse metric-stream sink requires Kafka group lifecycle events");
  const database = createDatabaseFromEnv();
  await runMetricStreamEventConsumer({
    consumer,
    quarantine,
    topic,
    epoch,
    lifecycleListener: readiness,
    handleEvents: async (events, context) => {
      await applyMetricStreamEventsToClickHouse(client, events, context, database);
    },
  });
}

export async function startMetricStreamClickHouseSinkFromEnv(): Promise<void> {
  const readiness = new MetricStreamConsumerReadiness();
  const server = createMetricStreamConsumerReadinessServer(readiness);
  await listenReadinessServer(server);
  server.unref();
  await runMetricStreamClickHouseSinkFromEnv(readiness);
}

function listenReadinessServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(3001, "0.0.0.0");
  });
}
