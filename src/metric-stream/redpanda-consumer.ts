import { performance } from "node:perf_hooks";
import { Kafka } from "kafkajs";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import {
  isMetricStreamDeletedEvent,
  type MetricStreamRedpandaEvent,
  metricStreamRedpandaEventSchema,
} from "./events.ts";
import {
  KafkaMetricStreamQuarantineWriter,
  type MetricStreamQuarantineWriter,
} from "./redpanda-quarantine.ts";

export interface MetricStreamKafkaMessage {
  offset: string;
  value: Buffer | null;
}

export interface MetricStreamEachBatchPayload {
  batch: {
    topic: string;
    partition: number;
    highWatermark?: string;
    messages: readonly MetricStreamKafkaMessage[];
  };
  commitOffsetsIfNecessary(): Promise<void>;
  heartbeat(): Promise<void>;
  resolveOffset(offset: string): void;
}

export interface MetricStreamConsumerLike {
  connect(): Promise<void>;
  observeGroupLifecycle?(listener: MetricStreamConsumerGroupLifecycleListener): void;
  subscribe(options: { topic: string; fromBeginning: boolean }): Promise<void>;
  run(options: {
    eachBatchAutoResolve: false;
    eachBatch(payload: MetricStreamEachBatchPayload): Promise<void>;
  }): Promise<void>;
}

export interface MetricStreamConsumerGroupLifecycleListener {
  markGroupJoined(): void;
  markUnavailable(): void;
}

export interface RunMetricStreamEventConsumerOptions {
  consumer: MetricStreamConsumerLike;
  handleEvents(
    events: MetricStreamRedpandaEvent[],
    context: MetricStreamConsumerBatchContext,
  ): Promise<void>;
  quarantine: MetricStreamQuarantineWriter;
  lifecycleListener?: MetricStreamConsumerGroupLifecycleListener;
  topic: string;
}

export interface MetricStreamConsumerBatchContext {
  topic: string;
  partition: number;
  eventOffsets: readonly string[];
  heartbeat(): Promise<void>;
}

function parseMetricStreamMessage(
  message: MetricStreamKafkaMessage & { value: Buffer },
): MetricStreamRedpandaEvent {
  try {
    return metricStreamRedpandaEventSchema.parse(JSON.parse(message.value.toString("utf8")));
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    logger.error(
      `[metric-stream] Rejecting malformed Redpanda message at offset ${message.offset}: ${messageText}`,
    );
    captureException(error, {
      extra: {
        offset: message.offset,
        valueBytes: message.value.byteLength,
      },
      tags: {
        metricStreamConsumer: "redpanda",
        metricStreamFailure: "malformed-message",
      },
    });
    throw error;
  }
}

export async function runMetricStreamEventConsumer(
  options: RunMetricStreamEventConsumerOptions,
): Promise<void> {
  const lagSamplesByPartition = new Map<number, { observedAt: number; lag: number }>();
  await options.quarantine.connect();
  await options.consumer.connect();
  await options.consumer.subscribe({ topic: options.topic, fromBeginning: false });
  if (options.lifecycleListener && options.consumer.observeGroupLifecycle) {
    options.consumer.observeGroupLifecycle(options.lifecycleListener);
  }
  await options.consumer.run({
    eachBatchAutoResolve: false,
    eachBatch: async (payload) => {
      const events: MetricStreamRedpandaEvent[] = [];
      const eventOffsets: string[] = [];
      for (const message of payload.batch.messages) {
        if (!message.value) {
          continue;
        }
        try {
          const event = parseMetricStreamMessage({
            offset: message.offset,
            value: message.value,
          });
          events.push(event);
          eventOffsets.push(message.offset);
        } catch (error) {
          try {
            await options.quarantine.write({
              error,
              offset: message.offset,
              partition: payload.batch.partition,
              payload: message.value,
              topic: payload.batch.topic,
            });
          } catch (quarantineError) {
            const messageText =
              quarantineError instanceof Error ? quarantineError.message : String(quarantineError);
            logger.error(
              `[metric-stream] Failed to quarantine Redpanda message at ${payload.batch.topic}/${payload.batch.partition}/${message.offset}: ${messageText}`,
            );
            captureException(quarantineError, {
              extra: {
                offset: message.offset,
                partition: payload.batch.partition,
                topic: payload.batch.topic,
                valueBytes: message.value.byteLength,
              },
              tags: {
                metricStreamConsumer: "redpanda",
                metricStreamFailure: "quarantine-write",
              },
            });
            throw quarantineError;
          }
        }
      }

      const sinkStartedAt = events.length > 0 ? performance.now() : null;
      if (events.length > 0) {
        await options.handleEvents(events, {
          topic: payload.batch.topic,
          partition: payload.batch.partition,
          eventOffsets,
          heartbeat: payload.heartbeat,
        });
      }

      const sinkDurationMs = sinkStartedAt === null ? null : performance.now() - sinkStartedAt;
      const deletionEventCount = events.filter(isMetricStreamDeletedEvent).length;
      const firstOffset = payload.batch.messages.at(0)?.offset;
      const lastOffset = payload.batch.messages.at(-1)?.offset;
      const highWatermark = payload.batch.highWatermark;
      const lag =
        lastOffset === undefined || highWatermark === undefined
          ? null
          : Number(BigInt(highWatermark) - BigInt(lastOffset) - 1n);
      const observedAt = performance.now();
      const priorLagSample = lagSamplesByPartition.get(payload.batch.partition);
      const lagElapsedSeconds = priorLagSample
        ? (observedAt - priorLagSample.observedAt) / 1_000
        : 0;
      const lagGrowthPerSecond =
        lag == null || !priorLagSample || lagElapsedSeconds <= 0
          ? null
          : (lag - priorLagSample.lag) / lagElapsedSeconds;
      if (lag != null) {
        lagSamplesByPartition.set(payload.batch.partition, { observedAt, lag });
      }
      logger.info("metric_stream.consumer_batch", {
        topic: payload.batch.topic,
        partition: payload.batch.partition,
        first_offset: firstOffset,
        last_offset: lastOffset,
        high_watermark: highWatermark,
        consumer_lag: lag,
        consumer_lag_growth_per_second: lagGrowthPerSecond,
        event_count: events.length,
        deletion_event_count: deletionEventCount,
        sink_duration_ms: sinkDurationMs,
        average_batch_event_cost_ms:
          sinkDurationMs === null ? null : sinkDurationMs / events.length,
        deletion_events_per_second:
          sinkDurationMs === null
            ? null
            : (deletionEventCount * 1_000) / Math.max(sinkDurationMs, 1),
      });

      for (const message of payload.batch.messages) {
        payload.resolveOffset(message.offset);
      }
      await payload.heartbeat();
      await payload.commitOffsetsIfNecessary();
    },
  });
}

function readRequiredEnvironmentValue(
  env: NodeJS.ProcessEnv,
  key: "METRIC_STREAM_TOPIC" | "REDPANDA_BROKERS",
): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

export function createKafkaMetricStreamConsumerFromEnv(
  groupId: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  consumer: MetricStreamConsumerLike;
  quarantine: MetricStreamQuarantineWriter;
  topic: string;
} {
  const topic = readRequiredEnvironmentValue(env, "METRIC_STREAM_TOPIC");
  const brokers = readRequiredEnvironmentValue(env, "REDPANDA_BROKERS")
    .split(",")
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
  if (brokers.length === 0) {
    throw new Error("REDPANDA_BROKERS must contain at least one broker");
  }

  const kafka = new Kafka({
    brokers,
    clientId: "dofek-metric-stream-consumer",
  });
  const kafkaConsumer = kafka.consumer({ groupId });

  return {
    consumer: {
      connect: () => kafkaConsumer.connect(),
      observeGroupLifecycle: (listener) => {
        kafkaConsumer.on(kafkaConsumer.events.GROUP_JOIN, () => listener.markGroupJoined());
        kafkaConsumer.on(kafkaConsumer.events.REBALANCING, () => listener.markUnavailable());
        kafkaConsumer.on(kafkaConsumer.events.DISCONNECT, () => listener.markUnavailable());
        kafkaConsumer.on(kafkaConsumer.events.STOP, () => listener.markUnavailable());
        kafkaConsumer.on(kafkaConsumer.events.CRASH, () => listener.markUnavailable());
      },
      subscribe: (options) => kafkaConsumer.subscribe(options),
      run: (options) => kafkaConsumer.run(options),
    },
    quarantine: new KafkaMetricStreamQuarantineWriter({
      admin: kafka.admin(),
      producer: kafka.producer(),
      sourceTopic: topic,
    }),
    topic,
  };
}
