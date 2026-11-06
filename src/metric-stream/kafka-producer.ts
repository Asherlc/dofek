import { Kafka } from "kafkajs";
import { captureException } from "../lib/error-reporting.ts";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamBatchPartitionKey,
  createMetricStreamDeletedEvent,
  createMetricStreamEvent,
  type MetricStreamDeleteScopeInput,
  type MetricStreamEventV2,
  type MetricStreamProcessingContext,
  type MetricStreamRowInput,
} from "./events.ts";
import type {
  MetricStreamEventPublisher,
  MetricStreamPublishOptions,
  MetricStreamReplacementPublishResult,
} from "./publisher.ts";
import {
  assertWritableMetricStreamTopic,
  type MetricStreamRoute,
  metricStreamTopicForRoute,
} from "./routes.ts";

export interface KafkaProducerMessage {
  key: string;
  value: string;
}

/**
 * Domain cap under the broker's typical 1 MiB message size limit
 * (`message.max.bytes` broker-wide / `max.message.bytes` per topic; see
 * Apache Kafka broker configs). Headroom leaves room for keys and framing.
 * This is an application chunking bound — not a Redpanda-specific property.
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
   * Chunk large batches under {@link MAX_PRODUCE_REQUEST_BYTES} before calling
   * KafkaJS `producer.send`. KafkaJS may further split a send by partition; this
   * helper does not claim one `send` equals one wire ProduceRequest. Brokers
   * reject oversized records against `message.max.bytes` /
   * `max.message.bytes`. High-rate sources (e.g. HealthKit IMU bursts) and
   * historical backfill can exceed the domain cap, so split into ordered
   * sub-batches. Chunks preserve input order for callers that rely on ordering
   * (e.g. a delete before its replacements on the same partition key).
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

const metricStreamPublisherPromises = new Map<string, Promise<KafkaMetricStreamEventPublisher>>();

export function getDefaultMetricStreamEventPublisher(): Promise<MetricStreamEventPublisher> {
  return createKafkaMetricStreamEventPublisherForRoute("live");
}

function readRequiredEnvironmentValue(env: NodeJS.ProcessEnv, key: "KAFKA_BROKERS"): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

export async function createKafkaMetricStreamEventPublisherForRoute(
  route: MetricStreamRoute,
  env: NodeJS.ProcessEnv = process.env,
): Promise<KafkaMetricStreamEventPublisher> {
  const topic = metricStreamTopicForRoute(route, env);
  assertWritableMetricStreamTopic(topic);
  const brokers = readRequiredEnvironmentValue(env, "KAFKA_BROKERS")
    .split(",")
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
  if (brokers.length === 0) {
    throw new Error("KAFKA_BROKERS must contain at least one broker");
  }

  const publisherCacheKey = JSON.stringify([route, topic, brokers]);
  let publisherPromise = metricStreamPublisherPromises.get(publisherCacheKey);
  if (!publisherPromise) {
    publisherPromise = (async () => {
      const kafka = new Kafka({
        brokers,
        clientId: "dofek-metric-stream-kafka-producer",
      });
      const producer = kafka.producer();
      await producer.connect();
      return new KafkaMetricStreamEventPublisher(producer, topic);
    })();
    metricStreamPublisherPromises.set(publisherCacheKey, publisherPromise);
    void publisherPromise.catch((error: unknown) => {
      if (metricStreamPublisherPromises.get(publisherCacheKey) === publisherPromise) {
        metricStreamPublisherPromises.delete(publisherCacheKey);
      }
      captureException(error, {
        tags: {
          metricStreamProducer: "kafka",
          metricStreamFailure: "publisher-connect",
        },
      });
    });
  }
  return publisherPromise;
}

export async function closeAllKafkaMetricStreamEventPublishers(): Promise<void> {
  const publishers = await Promise.all([...metricStreamPublisherPromises.values()]);
  metricStreamPublisherPromises.clear();
  await Promise.all(publishers.map((publisher) => publisher.disconnect()));
}
