import { Kafka } from "kafkajs";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import { type MetricStreamRedpandaEvent, metricStreamRedpandaEventSchema } from "./events.ts";
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
    messages: readonly MetricStreamKafkaMessage[];
  };
  commitOffsetsIfNecessary(): Promise<void>;
  heartbeat(): Promise<void>;
  resolveOffset(offset: string): void;
}

export interface MetricStreamConsumerLike {
  connect(): Promise<void>;
  subscribe(options: { topic: string; fromBeginning: boolean }): Promise<void>;
  run(options: {
    eachBatchAutoResolve: false;
    eachBatch(payload: MetricStreamEachBatchPayload): Promise<void>;
  }): Promise<void>;
}

export interface RunMetricStreamEventConsumerOptions {
  consumer: MetricStreamConsumerLike;
  handleEvents(
    events: MetricStreamRedpandaEvent[],
    context: MetricStreamConsumerBatchContext,
  ): Promise<void>;
  quarantine: MetricStreamQuarantineWriter;
  topic: string;
}

export interface MetricStreamConsumerBatchContext {
  topic: string;
  partition: number;
  eventOffsets: readonly string[];
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
  await options.quarantine.connect();
  await options.consumer.connect();
  await options.consumer.subscribe({ topic: options.topic, fromBeginning: false });
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

      if (events.length > 0) {
        await options.handleEvents(events, {
          topic: payload.batch.topic,
          partition: payload.batch.partition,
          eventOffsets,
        });
      }

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
