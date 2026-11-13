import { createHash } from "node:crypto";
import type { Server } from "node:http";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  withAnalyticsQueryOwner,
} from "../analytics/analytics-query-owner.ts";
import { createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { createDatabaseFromEnv } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";
import type { ClickHouseMetricStreamInsertClient } from "./clickhouse-sink.ts";
import {
  applyMetricStreamEventsToClickHouse,
  keepMetricStreamHeartbeatAlive,
} from "./clickhouse-sink.ts";
import {
  createMetricStreamConsumerReadinessServer,
  MetricStreamConsumerReadiness,
} from "./consumer-readiness.ts";
import type { MetricStreamConsumerBatchContext } from "./redpanda-consumer.ts";
import {
  createKafkaMetricStreamConsumerFromEnv,
  runMetricStreamEventConsumer,
} from "./redpanda-consumer.ts";

function hasClickHouseInsertClient(
  client: Awaited<ReturnType<typeof createClickHouseClientFromEnv>>,
): client is typeof client & ClickHouseMetricStreamInsertClient {
  return typeof client.insert === "function";
}

export async function runMetricStreamClickHouseSinkFromEnv(
  readiness: MetricStreamConsumerReadiness,
): Promise<void> {
  const client = createClickHouseClientFromEnv();
  if (!hasClickHouseInsertClient(client)) {
    throw new Error("ClickHouse metric-stream sink requires an insert-capable client");
  }

  const { consumer, quarantine, topic } = createKafkaMetricStreamConsumerFromEnv();
  if (!consumer.observeGroupLifecycle) {
    throw new Error("ClickHouse metric-stream sink requires Kafka group lifecycle events");
  }
  const database = createDatabaseFromEnv();
  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  let shutdownStarted = false;
  const requestShutdown = (): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    readiness.markUnavailable();
    resolveShutdown();
  };
  process.on("SIGTERM", requestShutdown);
  process.on("SIGINT", requestShutdown);

  let firstFailure: unknown;
  let hasFirstFailure = false;
  const cleanupFailures: unknown[] = [];
  const captureCleanupFailure = (error: unknown): void => {
    cleanupFailures.push(error);
    captureException(error, { tags: { source: "metric-stream-sink-shutdown" } });
  };
  try {
    await runMetricStreamEventConsumer({
      consumer,
      quarantine,
      topic,
      lifecycleListener: {
        markGroupJoined: () => {
          if (!shutdownStarted) readiness.markGroupJoined();
        },
        markUnavailable: () => readiness.markUnavailable(),
      },
      handleEvents: async (events, context: MetricStreamConsumerBatchContext) => {
        const firstOffset = context.eventOffsets[0];
        if (firstOffset === undefined)
          throw new Error("ClickHouse metric-stream sink is missing its first Kafka offset");
        const intentId = `metric-stream:${createHash("sha256")
          .update(JSON.stringify([context.topic, context.partition, firstOffset]))
          .digest("hex")}`;
        await keepMetricStreamHeartbeatAlive(context, () =>
          withAnalyticsQueryOwner(
            database,
            client,
            { resourceId: ANALYTICS_PUBLICATION_RESOURCE, intentId },
            async (owner) => {
              await applyMetricStreamEventsToClickHouse(owner.client, events, context);
            },
          ),
        );
      },
    });
    await shutdownRequested;
  } catch (error) {
    firstFailure = error;
    hasFirstFailure = true;
    readiness.markUnavailable();
    captureException(error, { tags: { source: "metric-stream-sink-startup" } });
  } finally {
    readiness.markUnavailable();
    let consumerDrained = false;
    try {
      await consumer.stop();
      consumerDrained = true;
    } catch (error) {
      captureCleanupFailure(error);
    }
    if (consumerDrained) {
      try {
        await consumer.disconnect();
      } catch (error) {
        captureCleanupFailure(error);
      }
      try {
        await quarantine.disconnect();
      } catch (error) {
        captureCleanupFailure(error);
      }
      try {
        await database.$client.end();
      } catch (error) {
        captureCleanupFailure(error);
      }
      try {
        await client.close();
      } catch (error) {
        captureCleanupFailure(error);
      }
    }
    process.off("SIGTERM", requestShutdown);
    process.off("SIGINT", requestShutdown);
  }
  if (hasFirstFailure) throw firstFailure;
  if (cleanupFailures.length > 0) throw cleanupFailures[0];
}

export async function startMetricStreamClickHouseSinkFromEnv(): Promise<void> {
  const readiness = new MetricStreamConsumerReadiness();
  const readinessServer = createMetricStreamConsumerReadinessServer(readiness);
  await listenReadinessServer(readinessServer);
  readinessServer.unref();
  let failure: unknown;
  let hasFailure = false;
  try {
    await runMetricStreamClickHouseSinkFromEnv(readiness);
  } catch (error) {
    captureException(error, { tags: { source: "metric-stream-readiness-run" } });
    failure = error;
    hasFailure = true;
  }
  try {
    if (readinessServer.listening) {
      await new Promise<void>((resolve, reject) => {
        readinessServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } catch (error) {
    captureException(error, { tags: { source: "metric-stream-readiness-close" } });
    if (!hasFailure) {
      failure = error;
      hasFailure = true;
    }
  }
  if (hasFailure) throw failure;
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
