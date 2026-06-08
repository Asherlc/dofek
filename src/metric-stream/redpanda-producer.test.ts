import { describe, expect, it, vi } from "vitest";
import {
  createKafkaMetricStreamEventPublisherFromEnv,
  KafkaMetricStreamEventPublisher,
  type KafkaProducerLike,
  type KafkaProducerSendInput,
} from "./redpanda-producer.ts";

const kafkaProducerConnect = vi.hoisted(() => vi.fn(async () => undefined));
const kafkaProducerDisconnect = vi.hoisted(() => vi.fn(async () => undefined));
const kafkaProducerSend = vi.hoisted(() =>
  vi.fn(async (_input: KafkaProducerSendInput) => undefined),
);
const kafkaProducerFactory = vi.hoisted(() =>
  vi.fn(() => ({
    connect: kafkaProducerConnect,
    disconnect: kafkaProducerDisconnect,
    send: kafkaProducerSend,
  })),
);
const kafkaConstructor = vi.hoisted(() =>
  vi.fn(() => ({
    producer: kafkaProducerFactory,
  })),
);

vi.mock("kafkajs", () => ({
  Kafka: kafkaConstructor,
}));

const metricStreamRow = {
  recordedAt: "2026-06-06T12:00:00-07:00",
  userId: "00000000-0000-0000-0000-000000000001",
  providerId: "apple_health",
  externalId: "hk:heart-rate-1",
  deviceId: "Apple Watch",
  sourceType: "api",
  channel: "heart_rate",
  scalar: 72,
};

function makeProducer() {
  const connect = vi.fn(async () => undefined);
  const disconnect = vi.fn(async () => undefined);
  const send = vi.fn(async (_input: KafkaProducerSendInput) => undefined);
  const producer: KafkaProducerLike = { connect, disconnect, send };
  return { connect, disconnect, producer, send };
}

describe("KafkaMetricStreamEventPublisher", () => {
  it("publishes versioned metric stream events keyed by event ID", async () => {
    const { producer, send } = makeProducer();
    const publisher = new KafkaMetricStreamEventPublisher(producer, "metric-stream-v1");

    const events = await publisher.publishRows([metricStreamRow]);

    expect(events).toHaveLength(1);
    expect(events[0]?.version).toBe(1);
    expect(events[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(events[0]?.recordedAt).toBe("2026-06-06T19:00:00.000Z");
    expect(send).toHaveBeenCalledWith({
      topic: "metric-stream-v1",
      messages: [
        {
          key: events[0]?.id,
          value: JSON.stringify(events[0]),
        },
      ],
    });
  });

  it("does not send an empty batch", async () => {
    const { producer, send } = makeProducer();
    const publisher = new KafkaMetricStreamEventPublisher(producer, "metric-stream-v1");

    await expect(publisher.publishRows([])).resolves.toEqual([]);

    expect(send).not.toHaveBeenCalled();
  });

  it("publishes row batches on a supplied replacement partition key", async () => {
    const { producer, send } = makeProducer();
    const publisher = new KafkaMetricStreamEventPublisher(producer, "metric-stream-v1");

    const events = await publisher.publishRows(
      [metricStreamRow],
      "provider:00000000-0000-0000-0000-000000000001:apple_health:*:*:2026-06-01T00:00:00.000Z:*",
    );

    expect(send).toHaveBeenCalledWith({
      topic: "metric-stream-v1",
      messages: [
        {
          key: "provider:00000000-0000-0000-0000-000000000001:apple_health:*:*:2026-06-01T00:00:00.000Z:*",
          value: JSON.stringify(events[0]),
        },
      ],
    });
  });

  it("publishes scoped replacements with a delete event before row events on the same key", async () => {
    const { producer, send } = makeProducer();
    const publisher = new KafkaMetricStreamEventPublisher(producer, "metric-stream-v1");

    const events = await publisher.replaceRows(
      { activityId: "20000000-0000-4000-8000-000000000001" },
      [metricStreamRow],
    );

    expect(events.deleted.partitionKey).toBe("activity:20000000-0000-4000-8000-000000000001");
    expect(events.rows).toHaveLength(1);
    expect(send).toHaveBeenCalledWith({
      topic: "metric-stream-v1",
      messages: [
        {
          key: "activity:20000000-0000-4000-8000-000000000001",
          value: JSON.stringify(events.deleted),
        },
        {
          key: "activity:20000000-0000-4000-8000-000000000001",
          value: JSON.stringify(events.rows[0]),
        },
      ],
    });
  });

  it("splits oversized publish batches into multiple produce requests", async () => {
    const { producer, send } = makeProducer();
    const publisher = new KafkaMetricStreamEventPublisher(producer, "metric-stream-v1");

    // Each event ~500KB of metadata; two together exceed the ~900KB request cap.
    const bigMetadata = { blob: "x".repeat(500_000) };
    const rows = [0, 1, 2].map((index) => ({
      ...metricStreamRow,
      externalId: `hk:big-${index}`,
      metadata: bigMetadata,
    }));

    const events = await publisher.publishRows(rows);

    expect(events).toHaveLength(3);
    // Cap forces one event per request here (2 x 500KB > 900KB).
    expect(send.mock.calls.length).toBeGreaterThan(1);
    const sentMessages = send.mock.calls.flatMap((call) => call[0].messages);
    expect(sentMessages).toHaveLength(3);
    expect(sentMessages.map((message) => message.value)).toEqual(
      events.map((event) => JSON.stringify(event)),
    );
  });

  it("throws when a single message exceeds the produce size cap", async () => {
    const { producer, send } = makeProducer();
    const publisher = new KafkaMetricStreamEventPublisher(producer, "metric-stream-v1");

    // One event whose JSON alone exceeds the cap — atomic, so it can never be sent.
    const oversized = { ...metricStreamRow, metadata: { blob: "x".repeat(1_000_000) } };

    await expect(publisher.publishRows([oversized])).rejects.toThrow(
      /over the \d+-byte produce limit/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the delete event first when a scoped replacement is chunked", async () => {
    const { producer, send } = makeProducer();
    const publisher = new KafkaMetricStreamEventPublisher(producer, "metric-stream-v1");

    const bigMetadata = { blob: "x".repeat(500_000) };
    const rows = [0, 1].map((index) => ({
      ...metricStreamRow,
      externalId: `hk:repl-${index}`,
      metadata: bigMetadata,
    }));

    await publisher.replaceRows({ activityId: "20000000-0000-4000-8000-000000000001" }, rows);

    expect(send.mock.calls.length).toBeGreaterThan(1);
    const firstMessage = send.mock.calls[0]?.[0].messages[0];
    expect(JSON.parse(firstMessage?.value ?? "{}").eventType).toBe("metric_stream_deleted");
  });

  it("disconnects the KafkaJS producer when disposed", async () => {
    const { disconnect, producer } = makeProducer();
    const publisher = new KafkaMetricStreamEventPublisher(producer, "metric-stream-v1");

    await publisher.disconnect();

    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("rejects empty strings for absent text values", async () => {
    const { producer } = makeProducer();
    const publisher = new KafkaMetricStreamEventPublisher(producer, "metric-stream-v1");

    await expect(
      publisher.publishRows([
        {
          ...metricStreamRow,
          externalId: "",
        },
      ]),
    ).rejects.toThrow();
  });
});

describe("createKafkaMetricStreamEventPublisherFromEnv", () => {
  it("requires Redpanda brokers", async () => {
    await expect(
      createKafkaMetricStreamEventPublisherFromEnv({
        METRIC_STREAM_TOPIC: "metric-stream-v1",
      }),
    ).rejects.toThrow("REDPANDA_BROKERS is required");
  });

  it("requires a metric stream topic", async () => {
    await expect(
      createKafkaMetricStreamEventPublisherFromEnv({
        REDPANDA_BROKERS: "redpanda:9092",
      }),
    ).rejects.toThrow("METRIC_STREAM_TOPIC is required");
  });

  it("rejects broker lists that only contain separators and whitespace", async () => {
    await expect(
      createKafkaMetricStreamEventPublisherFromEnv({
        METRIC_STREAM_TOPIC: "metric-stream-v1",
        REDPANDA_BROKERS: " , ",
      }),
    ).rejects.toThrow("REDPANDA_BROKERS must contain at least one broker");
  });

  it("trims broker lists, connects the producer, and returns a publisher for valid env", async () => {
    kafkaConstructor.mockClear();
    kafkaProducerFactory.mockClear();
    kafkaProducerConnect.mockClear();

    const publisher = await createKafkaMetricStreamEventPublisherFromEnv({
      METRIC_STREAM_TOPIC: "metric-stream-v1",
      REDPANDA_BROKERS: " redpanda:9092 , redpanda:9093 ",
    });

    expect(publisher).toBeInstanceOf(KafkaMetricStreamEventPublisher);
    expect(kafkaConstructor).toHaveBeenCalledWith({
      brokers: ["redpanda:9092", "redpanda:9093"],
      clientId: "dofek-metric-stream-producer",
    });
    expect(kafkaProducerFactory).toHaveBeenCalledOnce();
    expect(kafkaProducerConnect).toHaveBeenCalledOnce();
  });
});
