import Pulsar from "pulsar-client";
import { captureException } from "../lib/error-reporting.ts";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamBatchPartitionKey,
  createMetricStreamDeletedEvent,
  createMetricStreamEvent,
  type MetricStreamDeleteScopeInput,
  type MetricStreamProcessingContext,
  type MetricStreamRowInput,
} from "./events.ts";
import type {
  MetricStreamEventPublisher,
  MetricStreamPublishOptions,
  MetricStreamReplacementPublishResult,
} from "./publisher.ts";
import { type MetricStreamRoute, metricStreamTopicForRoute } from "./routes.ts";

const MAX_PENDING_MESSAGES = 20;
const MAX_SERIALIZED_BYTES = 900_000;
type Producer = {
  send(message: { data: Buffer; partitionKey: string }): Promise<unknown>;
  close(): Promise<unknown>;
};
type OutgoingEvent = { event: unknown; partitionKey: string };

function serializeEvent(event: unknown): string {
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized) > MAX_SERIALIZED_BYTES) {
    throw new Error(`Metric-stream event exceeds the ${MAX_SERIALIZED_BYTES}-byte produce limit`);
  }
  return serialized;
}

export class PulsarMetricStreamEventPublisher implements MetricStreamEventPublisher {
  readonly #producer: Producer;
  readonly #closeResources: () => Promise<void>;
  #closed = false;
  #disconnecting: Promise<void> | undefined;

  constructor(producer: Producer, closeResources: () => Promise<void>) {
    this.#producer = producer;
    this.#closeResources = closeResources;
  }

  async #sendEvents(events: readonly OutgoingEvent[]): Promise<void> {
    let window: Array<{ data: Buffer; partitionKey: string }> = [];
    let bytes = 0;
    const flush = async () => {
      if (this.#closed) throw new Error("Pulsar metric-stream publisher is closed");
      const outcomes = await Promise.allSettled(
        window.map(async (message) => this.#producer.send(message)),
      );
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure?.status === "rejected") {
        const error = new Error("Pulsar metric-stream send failed; publication may have occurred", {
          cause: failure.reason,
        });
        captureException(error, {
          tags: { metricStreamProducer: "pulsar", metricStreamFailure: "send" },
        });
        throw error;
      }
      window = [];
      bytes = 0;
    };
    for (const { event, partitionKey } of events) {
      const data = Buffer.from(serializeEvent(event));
      if (
        window.length &&
        (window.length === MAX_PENDING_MESSAGES || bytes + data.byteLength > MAX_SERIALIZED_BYTES)
      ) {
        await flush();
      }
      window.push({ data, partitionKey });
      bytes += data.byteLength;
    }
    if (window.length) await flush();
  }

  async publishRows(rows: readonly MetricStreamRowInput[], options: MetricStreamPublishOptions) {
    const events = rows.map((row) => createMetricStreamEvent(row, options.operationRevision));
    if (!events.length) return [];
    const partitionKey = options.processing
      ? (options.partitionKey ?? createMetricStreamBatchPartitionKey(options.processing))
      : options.partitionKey;
    const marker = options.processing
      ? createMetricStreamBatchCompletedEvent(options.processing, events.length, partitionKey)
      : undefined;
    const outgoing = events.map((event) => ({ event, partitionKey: partitionKey ?? event.id }));
    for (const { event } of outgoing) serializeEvent(event);
    if (marker) serializeEvent(marker);
    await this.#sendEvents(outgoing);
    if (marker) await this.#sendEvents([{ event: marker, partitionKey: marker.partitionKey }]);
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
    const marker = processing
      ? createMetricStreamBatchCompletedEvent(processing, events.length + 1, deleted.partitionKey)
      : undefined;
    const outgoing = events.map((event) => ({ event, partitionKey: deleted.partitionKey }));
    serializeEvent(deleted);
    for (const { event } of outgoing) serializeEvent(event);
    if (marker) serializeEvent(marker);
    await this.#sendEvents([{ event: deleted, partitionKey: deleted.partitionKey }]);
    await this.#sendEvents(outgoing);
    if (marker) await this.#sendEvents([{ event: marker, partitionKey: deleted.partitionKey }]);
    return { deleted, rows: events };
  }

  disconnect(): Promise<void> {
    this.#closed = true;
    this.#disconnecting ??= this.#closeResources();
    return this.#disconnecting;
  }
}

const publishers = new Map<string, Promise<PulsarMetricStreamEventPublisher>>();
let shuttingDown = false;
let shutdown: Promise<void> | undefined;

export function closeAllMetricStreamEventPublishers(): Promise<void> {
  shuttingDown = true;
  shutdown ??= (async () => {
    const initialized = await Promise.allSettled([...publishers.values()]);
    const closed = await Promise.allSettled(
      initialized.flatMap((outcome) =>
        outcome.status === "fulfilled" ? [outcome.value.disconnect()] : [],
      ),
    );
    const failures = [...initialized, ...closed].flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length) {
      const error = new AggregateError(failures, "Pulsar publisher shutdown failed");
      captureException(error, {
        tags: { metricStreamProducer: "pulsar", metricStreamFailure: "publisher-shutdown" },
      });
      throw error;
    }
  })();
  return shutdown;
}

export function getDefaultMetricStreamEventPublisher(): Promise<MetricStreamEventPublisher> {
  return createPulsarMetricStreamEventPublisherForRoute("live");
}

export async function createPulsarMetricStreamEventPublisherForRoute(
  route: MetricStreamRoute,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PulsarMetricStreamEventPublisher> {
  if (shuttingDown) throw new Error("Pulsar metric-stream publisher pool is shutting down");
  const topic = metricStreamTopicForRoute(route, env);
  const serviceUrl = env.PULSAR_SERVICE_URL?.trim();
  if (!serviceUrl) throw new Error("PULSAR_SERVICE_URL is required");
  const cacheKey = JSON.stringify([route, topic, serviceUrl]);
  const cached = publishers.get(cacheKey);
  if (cached) return cached;
  const pending = (async () => {
    const client = new Pulsar.Client({ serviceUrl });
    try {
      const producer = await client.createProducer({
        topic,
        maxPendingMessages: MAX_PENDING_MESSAGES,
        maxPendingMessagesAcrossPartitions: MAX_PENDING_MESSAGES,
        blockIfQueueFull: false,
        sendTimeoutMs: 30_000,
        batchingEnabled: true,
        batchingMaxMessages: MAX_PENDING_MESSAGES,
        batchingMaxAllowedSizeInBytes: MAX_SERIALIZED_BYTES,
        chunkingEnabled: false,
      });
      return new PulsarMetricStreamEventPublisher(producer, async () => {
        if (publishers.get(cacheKey) === pending) publishers.delete(cacheKey);
        const failures: unknown[] = [];
        for (const close of [() => producer.close(), () => client.close()]) {
          try {
            await close();
          } catch (error) {
            captureException(error, {
              tags: { metricStreamProducer: "pulsar", metricStreamFailure: "publisher-close" },
            });
            failures.push(error);
          }
        }
        if (failures.length > 1)
          throw new AggregateError(failures, "Pulsar publisher shutdown failed");
        if (failures.length) throw failures[0];
      });
    } catch (error) {
      try {
        await client.close();
      } catch (cleanupError) {
        captureException(cleanupError, {
          tags: {
            metricStreamProducer: "pulsar",
            metricStreamFailure: "publisher-connect-cleanup",
          },
        });
      }
      throw error;
    }
  })();
  publishers.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    if (publishers.get(cacheKey) === pending) publishers.delete(cacheKey);
    captureException(error, {
      tags: { metricStreamProducer: "pulsar", metricStreamFailure: "publisher-connect" },
    });
    throw error;
  }
}
