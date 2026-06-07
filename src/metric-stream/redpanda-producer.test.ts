import { describe, expect, it, vi } from "vitest";
import {
  createKafkaMetricStreamEventPublisherFromEnv,
  getDefaultMetricStreamEventPublisher,
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

describe("getDefaultMetricStreamEventPublisher", () => {
  it("does not permanently cache failed publisher initialization", async () => {
    const originalTopic = process.env.METRIC_STREAM_TOPIC;
    const originalBrokers = process.env.REDPANDA_BROKERS;

    try {
      delete process.env.METRIC_STREAM_TOPIC;
      process.env.REDPANDA_BROKERS = "redpanda:9092";
      await expect(getDefaultMetricStreamEventPublisher()).rejects.toThrow(
        "METRIC_STREAM_TOPIC is required",
      );

      process.env.METRIC_STREAM_TOPIC = "metric-stream-v1";
      kafkaProducerConnect.mockClear();
      await expect(getDefaultMetricStreamEventPublisher()).resolves.toBeInstanceOf(
        KafkaMetricStreamEventPublisher,
      );
      expect(kafkaProducerConnect).toHaveBeenCalledOnce();
    } finally {
      if (originalTopic === undefined) {
        delete process.env.METRIC_STREAM_TOPIC;
      } else {
        process.env.METRIC_STREAM_TOPIC = originalTopic;
      }
      if (originalBrokers === undefined) {
        delete process.env.REDPANDA_BROKERS;
      } else {
        process.env.REDPANDA_BROKERS = originalBrokers;
      }
    }
  });
});
