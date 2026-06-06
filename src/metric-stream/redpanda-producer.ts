import { Kafka } from "kafkajs";
import {
  createMetricStreamEvent,
  type MetricStreamEventV1,
  type MetricStreamRowInput,
} from "./events.ts";

export interface KafkaProducerMessage {
  key: string;
  value: string;
}

export interface KafkaProducerSendInput {
  topic: string;
  messages: KafkaProducerMessage[];
}

export interface KafkaProducerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(input: KafkaProducerSendInput): Promise<unknown>;
}

export interface MetricStreamEventPublisher {
  publishRows(rows: readonly MetricStreamRowInput[]): Promise<MetricStreamEventV1[]>;
}

export class KafkaMetricStreamEventPublisher implements MetricStreamEventPublisher {
  readonly #producer: KafkaProducerLike;
  readonly #topic: string;

  constructor(producer: KafkaProducerLike, topic: string) {
    if (topic.length === 0) {
      throw new Error("METRIC_STREAM_TOPIC must not be empty");
    }
    this.#producer = producer;
    this.#topic = topic;
  }

  async publishRows(rows: readonly MetricStreamRowInput[]): Promise<MetricStreamEventV1[]> {
    const events = rows.map((row) => createMetricStreamEvent(row));
    if (events.length === 0) {
      return [];
    }

    await this.#producer.send({
      topic: this.#topic,
      messages: events.map((event) => ({
        key: event.id,
        value: JSON.stringify(event),
      })),
    });

    return events;
  }

  async disconnect(): Promise<void> {
    await this.#producer.disconnect();
  }
}

let defaultMetricStreamPublisherPromise: Promise<MetricStreamEventPublisher> | undefined;

export function getDefaultMetricStreamEventPublisher(): Promise<MetricStreamEventPublisher> {
  defaultMetricStreamPublisherPromise ??= createKafkaMetricStreamEventPublisherFromEnv().catch(
    (error: unknown) => {
      defaultMetricStreamPublisherPromise = undefined;
      throw error;
    },
  );
  return defaultMetricStreamPublisherPromise;
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

export async function createKafkaMetricStreamEventPublisherFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<KafkaMetricStreamEventPublisher> {
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
    clientId: "dofek-metric-stream-producer",
  });

  const producer = kafka.producer();
  await producer.connect();
  return new KafkaMetricStreamEventPublisher(producer, topic);
}
