import { captureException } from "@sentry/node";
import { Kafka } from "kafkajs";
import { logger } from "../logger.ts";
import { type MetricStreamRedpandaEvent, metricStreamRedpandaEventSchema } from "./events.ts";

export interface MetricStreamKafkaMessage {
  offset: string;
  value: Buffer | null;
}

export interface MetricStreamEachBatchPayload {
  batch: {
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
  handleEvents(events: MetricStreamRedpandaEvent[]): Promise<void>;
  topic: string;
}

function parseMetricStreamMessage(
  message: MetricStreamKafkaMessage,
): MetricStreamRedpandaEvent | null {
  if (!message.value) {
    return null;
  }
  try {
    return metricStreamRedpandaEventSchema.parse(JSON.parse(message.value.toString("utf8")));
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    logger.error(
      `[metric-stream] Skipping malformed Redpanda message at offset ${message.offset}: ${messageText}`,
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
    return null;
  }
}

export async function runMetricStreamEventConsumer(
  options: RunMetricStreamEventConsumerOptions,
): Promise<void> {
  await options.consumer.connect();
  await options.consumer.subscribe({ topic: options.topic, fromBeginning: false });
  await options.consumer.run({
    eachBatchAutoResolve: false,
    eachBatch: async (payload) => {
      const events = payload.batch.messages.flatMap((message) => {
        const event = parseMetricStreamMessage(message);
        return event ? [event] : [];
      });

      if (events.length > 0) {
        await options.handleEvents(events);
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
): { consumer: MetricStreamConsumerLike; topic: string } {
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
    topic,
  };
}
