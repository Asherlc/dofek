import { Kafka } from "kafkajs";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamBatchPartitionKey,
  createMetricStreamDeletedEvent,
  createMetricStreamEvent,
  type MetricStreamDeletedEventV3,
  type MetricStreamDeleteScopeInput,
  type MetricStreamEventV2,
  type MetricStreamProcessingContext,
  type MetricStreamRowInput,
} from "./events.ts";

export interface KafkaProducerMessage {
  key: string;
  value: string;
}

/**
 * Max bytes per produce request. Kept under Redpanda's 1 MiB default
 * `kafka_batch_max_bytes` (with headroom for keys + protocol framing) so a
 * single `producer.send` never trips "message larger than the max message size
 * the server will accept".
 */
const MAX_PRODUCE_REQUEST_BYTES = 900_000;

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
  publishRows(
    rows: readonly MetricStreamRowInput[],
    options: MetricStreamPublishOptions,
  ): Promise<MetricStreamEventV2[]>;
  replaceRows?(
    scope: MetricStreamDeleteScopeInput,
    rows: readonly MetricStreamRowInput[],
    operationRevision: string,
    processing?: MetricStreamProcessingContext,
  ): Promise<MetricStreamReplacementPublishResult>;
}

export interface MetricStreamPublishOptions {
  operationRevision: string;
  partitionKey?: string;
  processing?: MetricStreamProcessingContext;
}

export interface MetricStreamReplacementPublishResult {
  deleted: MetricStreamDeletedEventV3;
  rows: MetricStreamEventV2[];
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

  /**
   * Send messages in chunks that each stay under the broker's max request size.
   * One `producer.send` is one Kafka produce request, and Redpanda rejects
   * requests over `kafka_batch_max_bytes` (1 MiB default) with "message larger
   * than the max message size the server will accept". High-rate sources (e.g.
   * HealthKit IMU sample bursts) and the historical backfill can exceed that, so
   * split into ordered sub-requests. Chunks preserve input order, so callers
   * relying on ordering (e.g. a delete before its replacements on the same
   * partition key) stay correct.
   */
  async #sendChunked(messages: readonly KafkaProducerMessage[]): Promise<void> {
    let chunk: KafkaProducerMessage[] = [];
    let chunkBytes = 0;
    for (const message of messages) {
      const messageBytes = Buffer.byteLength(message.value, "utf8");
      if (messageBytes > MAX_PRODUCE_REQUEST_BYTES) {
        // A single Kafka message is atomic — it can't be split across requests,
        // so one over the cap can never be published. Fail loudly with the key
        // and size instead of sending a doomed over-limit produce request.
        throw new Error(
          `metric stream message ${message.key} is ${messageBytes} bytes, over the ${MAX_PRODUCE_REQUEST_BYTES}-byte produce limit`,
        );
      }
      if (chunk.length > 0 && chunkBytes + messageBytes > MAX_PRODUCE_REQUEST_BYTES) {
        await this.#producer.send({ topic: this.#topic, messages: chunk });
        chunk = [];
        chunkBytes = 0;
      }
      chunk.push(message);
      chunkBytes += messageBytes;
    }
    if (chunk.length > 0) {
      await this.#producer.send({ topic: this.#topic, messages: chunk });
    }
  }

  async publishRows(
    rows: readonly MetricStreamRowInput[],
    options: MetricStreamPublishOptions,
  ): Promise<MetricStreamEventV2[]> {
    const events = rows.map((row) => createMetricStreamEvent(row, options.operationRevision));
    if (events.length === 0) {
      return [];
    }

    const partitionKey = options.processing
      ? (options.partitionKey ?? createMetricStreamBatchPartitionKey(options.processing))
      : options.partitionKey;
    const processingMarker = options.processing
      ? createMetricStreamBatchCompletedEvent(options.processing, events.length, partitionKey)
      : undefined;

    await this.#sendChunked([
      ...events.map((event) => ({
        key: partitionKey ?? event.id,
        value: JSON.stringify(event),
      })),
      ...(processingMarker
        ? [{ key: processingMarker.partitionKey, value: JSON.stringify(processingMarker) }]
        : []),
    ]);

    return events;
  }

  async replaceRows(
    scope: MetricStreamDeleteScopeInput,
    rows: readonly MetricStreamRowInput[],
    operationRevision: string,
    processing?: MetricStreamProcessingContext,
  ): Promise<MetricStreamReplacementPublishResult> {
    const deleted = createMetricStreamDeletedEvent(scope, operationRevision);
    const events = rows.map((row) => createMetricStreamEvent(row, operationRevision));
    const processingMarker = processing
      ? createMetricStreamBatchCompletedEvent(processing, events.length + 1, deleted.partitionKey)
      : undefined;

    // Delete event first, then replacements — all on the same partition key, so
    // chunking into multiple ordered requests preserves delete-before-insert.
    await this.#sendChunked([
      { key: deleted.partitionKey, value: JSON.stringify(deleted) },
      ...events.map((event) => ({
        key: deleted.partitionKey,
        value: JSON.stringify(event),
      })),
      ...(processingMarker
        ? [{ key: deleted.partitionKey, value: JSON.stringify(processingMarker) }]
        : []),
    ]);

    return { deleted, rows: events };
  }

  async disconnect(): Promise<void> {
    await this.#producer.disconnect();
  }
}

let defaultMetricStreamPublisherPromise: Promise<MetricStreamEventPublisher> | undefined;

export function getDefaultMetricStreamEventPublisher(): Promise<MetricStreamEventPublisher> {
  defaultMetricStreamPublisherPromise ??= createKafkaMetricStreamEventPublisherFromEnv();
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
