import Pulsar, { type Consumer, type Message } from "pulsar-client";
import { describe, expect, it, vi } from "vitest";
import type { MetricStreamRedpandaEvent } from "./events.ts";
import type { PulsarMetricStreamBatchContext } from "./pulsar-consumer.ts";
import { runPulsarMetricStreamConsumer } from "./pulsar-consumer.ts";

vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));

const topic = "persistent://public/default/sensor-partition-2";
const event = {
  version: 2,
  operationRevision: "9007199254740993",
  id: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  recordedAt: "2026-01-01T00:00:00.123456Z",
  providerId: "fixture",
  sourceType: "sensor",
  channel: "heart_rate",
  generation: 0,
  scalar: 123,
} satisfies MetricStreamRedpandaEvent;
const payload = Buffer.from(JSON.stringify(event));

function input() {
  const controller = new AbortController();
  const trace: string[] = [];
  const consumer = {
    receive: vi.fn<Consumer["receive"]>(),
    acknowledge: vi.fn<Consumer["acknowledge"]>().mockImplementation(async () => {
      trace.push("ack");
      controller.abort();
      return null;
    }),
    isConnected: vi.fn().mockReturnValue(true),
    close: vi.fn<Consumer["close"]>().mockResolvedValue(null),
  };
  const client = { subscribe: vi.fn().mockResolvedValue(consumer) };
  return {
    controller,
    trace,
    consumer,
    client,
    options: {
      client,
      topic,
      partition: 2,
      epoch: "fixture-epoch",
      subscription: "sensor-sink",
      receiverQueueSize: 20,
      signal: controller.signal,
    },
  };
}

function message(payload: Buffer): Message {
  // The native binding exposes named properties on an array; JSON.stringify loses them.
  const properties = Object.assign([], { "__debezium.oldkey": "original-key" });
  function hasStringProperties(value: unknown): value is Record<string, string> {
    return (
      typeof value === "object" &&
      value !== null &&
      Object.values(value).every((entry) => typeof entry === "string")
    );
  }
  if (!hasStringProperties(properties)) throw new Error("Invalid native header fixture");
  return {
    getData: () => payload,
    getTopicName: () => topic,
    getPartitionKey: () => "source-key",
    getProperties: () => properties,
    getMessageId: () => Pulsar.MessageId.deserialize(Buffer.from("080a100018022000", "hex")),
    getPublishTimestamp: () => 0,
    getEventTimestamp: () => 0,
    getRedeliveryCount: () => 0,
    getOrderingKey: () => "",
    getProducerName: () => "fixture",
    isReplicated: () => false,
    getReplicatedFrom: () => "",
    getEncryptionContext: () => null,
  };
}

describe("Pulsar metric intake", () => {
  it("persists handling before individual ACK and preserves native delivery metadata", async () => {
    const fixture = input();
    const bytes = Buffer.from(payload);
    fixture.consumer.receive.mockResolvedValue(message(bytes));
    const handleEvents = vi.fn(
      async (events: MetricStreamRedpandaEvent[], context: PulsarMetricStreamBatchContext) => {
        expect(events).toEqual([event]);
        fixture.trace.push("durable-handler");
        expect(context.positions[0]).toMatchObject({
          transport: "pulsar",
          epoch: "fixture-epoch",
          topic,
          partition: 2,
          delivery: { major: "10", minor: "0", batch: 0 },
        });
        expect(context.deliveries[0]).toMatchObject({
          data: bytes,
          key: "source-key",
          properties: { "__debezium.oldkey": "original-key" },
        });
        await context.assertActive();
      },
    );
    await runPulsarMetricStreamConsumer({ ...fixture.options, handleEvents });
    expect(fixture.trace).toEqual(["durable-handler", "ack"]);
    expect(fixture.client.subscribe).toHaveBeenCalledWith({
      topic,
      subscription: "sensor-sink",
      subscriptionType: "Exclusive",
      subscriptionInitialPosition: "Earliest",
      receiverQueueSize: 20,
      batchIndexAckEnabled: true,
    });
    expect(fixture.consumer.close).toHaveBeenCalledTimes(1);
  });

  it("does not ACK a handler failure and closes intake instead of redelivery looping", async () => {
    const fixture = input();
    fixture.consumer.receive.mockResolvedValue(message(payload));
    await expect(
      runPulsarMetricStreamConsumer({
        ...fixture.options,
        handleEvents: async () => {
          throw new Error("journal unavailable");
        },
      }),
    ).rejects.toThrow("journal unavailable");
    expect(fixture.consumer.acknowledge).not.toHaveBeenCalled();
    expect(fixture.consumer.close).toHaveBeenCalledTimes(1);
    expect(fixture.consumer.receive).toHaveBeenCalledTimes(1);
  });

  it("refuses ACK when connection ownership is lost during handling", async () => {
    const fixture = input();
    fixture.consumer.receive.mockResolvedValue(message(payload));
    await expect(
      runPulsarMetricStreamConsumer({
        ...fixture.options,
        handleEvents: async () => {
          fixture.consumer.isConnected.mockReturnValue(false);
        },
      }),
    ).rejects.toThrow(/active|connected|ownership/i);
    expect(fixture.consumer.acknowledge).not.toHaveBeenCalled();
    expect(fixture.consumer.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces receive errors without acknowledging or looping", async () => {
    const fixture = input();
    fixture.consumer.receive.mockRejectedValue(new Error("broker unavailable"));
    await expect(
      runPulsarMetricStreamConsumer({ ...fixture.options, handleEvents: vi.fn() }),
    ).rejects.toThrow("broker unavailable");
    expect(fixture.consumer.receive).toHaveBeenCalledTimes(1);
    expect(fixture.consumer.acknowledge).not.toHaveBeenCalled();
    expect(fixture.consumer.close).toHaveBeenCalledTimes(1);
  });

  it("stops a pending receive without dispatching or acknowledging after shutdown", async () => {
    const fixture = input();
    fixture.consumer.receive.mockImplementation(() => {
      fixture.controller.abort();
      return Promise.reject(new Error("Consumer closed during receive"));
    });
    const handleEvents = vi.fn();
    await runPulsarMetricStreamConsumer({ ...fixture.options, handleEvents });
    expect(handleEvents).not.toHaveBeenCalled();
    expect(fixture.consumer.acknowledge).not.toHaveBeenCalled();
    expect(fixture.consumer.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed close even when the native receive never settles", async () => {
    const fixture = input();
    const failure = new Error("native close failed");
    fixture.consumer.close.mockRejectedValue(failure);
    fixture.consumer.receive.mockImplementation(() => {
      fixture.controller.abort();
      return new Promise<Message>(() => {});
    });
    const outcome = runPulsarMetricStreamConsumer({
      ...fixture.options,
      handleEvents: vi.fn(),
    }).then(
      () => "unexpected success",
      (error: unknown) => error,
    );
    const firstTurn = new Promise<string>((resolve) =>
      setImmediate(() => resolve("still pending")),
    );
    expect(await Promise.race([outcome, firstTurn])).toBe(failure);
    expect(fixture.consumer.acknowledge).not.toHaveBeenCalled();
  });

  it("surfaces an ACK failure and stops before receiving another delivery", async () => {
    const fixture = input();
    fixture.consumer.receive.mockResolvedValue(message(payload));
    fixture.consumer.acknowledge.mockRejectedValue(new Error("ACK failed"));
    await expect(
      runPulsarMetricStreamConsumer({ ...fixture.options, handleEvents: vi.fn() }),
    ).rejects.toThrow("ACK failed");
    expect(fixture.consumer.receive).toHaveBeenCalledTimes(1);
    expect(fixture.consumer.close).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5])("rejects invalid queue bound %s before subscribing", async (size) => {
    const fixture = input();
    await expect(
      runPulsarMetricStreamConsumer({
        ...fixture.options,
        receiverQueueSize: size,
        handleEvents: vi.fn(),
      }),
    ).rejects.toThrow(/queue/i);
    expect(fixture.client.subscribe).not.toHaveBeenCalled();
  });
});
