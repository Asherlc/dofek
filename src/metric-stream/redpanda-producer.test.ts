import { describe, expect, it, vi } from "vitest";
import {
  createKafkaMetricStreamEventPublisherFromEnv,
  KafkaMetricStreamEventPublisher,
  type KafkaProducerLike,
  type KafkaProducerSendInput,
} from "./redpanda-producer.ts";

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
  const send = vi.fn(async (_input: KafkaProducerSendInput) => undefined);
  const producer: KafkaProducerLike = { send };
  return { producer, send };
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
  it("requires Redpanda brokers", () => {
    expect(() =>
      createKafkaMetricStreamEventPublisherFromEnv({
        METRIC_STREAM_TOPIC: "metric-stream-v1",
      }),
    ).toThrow("REDPANDA_BROKERS is required");
  });

  it("requires a metric stream topic", () => {
    expect(() =>
      createKafkaMetricStreamEventPublisherFromEnv({
        REDPANDA_BROKERS: "redpanda:9092",
      }),
    ).toThrow("METRIC_STREAM_TOPIC is required");
  });
});
