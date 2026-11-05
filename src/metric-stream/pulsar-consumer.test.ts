import Pulsar, { type Consumer, type Message } from "pulsar-client";
import { describe, expect, it, vi } from "vitest";
import { describeAnalyticsDeliveryGroup } from "../analytics/analytics-delivery-group.ts";
import { captureException } from "../lib/error-reporting.ts";
import { MetricStreamConsumerReadiness } from "./consumer-readiness.ts";
import type { MetricStreamRedpandaEvent } from "./events.ts";
import type { PulsarMetricStreamBatchContext } from "./pulsar-consumer.ts";
import { runPulsarMetricStreamConsumer } from "./pulsar-consumer.ts";
import { metricStreamPosition } from "./transport-position.ts";

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
    batchReceive: vi.fn<Consumer["batchReceive"]>(),
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
      readiness: new MetricStreamConsumerReadiness(),
      topic,
      partition: 2,
      epoch: "fixture-epoch",
      subscription: "sensor-sink",
      receiverQueueSize: 20,
      nativeBatchMessages: 20,
      nativeBatchBytes: 8 * 1024 * 1024,
      maxGroupMessages: 1,
      maxGroupBytes: 8 * 1024 * 1024,
      loadPendingGroup: vi.fn().mockResolvedValue(null),
      signal: controller.signal,
    },
  };
}

function message(payload: Buffer, entry = 0, extraProperties?: Record<string, string>): Message {
  // The native binding exposes named properties on an array; JSON.stringify loses them.
  const properties = Object.assign([], { "source.original-key": "original-key" });
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
    getProperties: () => extraProperties ?? properties,
    getMessageId: () => {
      const bytes: number[] = [];
      let coordinate = entry;
      do {
        bytes.push((coordinate % 128) | (coordinate >= 128 ? 128 : 0));
        coordinate = Math.floor(coordinate / 128);
      } while (coordinate > 0);
      return Pulsar.MessageId.deserialize(
        Buffer.from([0x08, 0x0a, 0x10, ...bytes, 0x18, 0x02, 0x20, 0x00]),
      );
    },
    getPublishTimestamp: () => 1770000000123,
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
  it("never reports ready when abort runs between initial validation and readiness publication", async () => {
    const fixture = input();
    const readiness = fixture.options.readiness;
    const statuses: string[] = [];
    const markReady = readiness.markReady.bind(readiness);
    vi.spyOn(readiness, "markReady").mockImplementation((probe) => {
      markReady(probe);
      statuses.push(readiness.getStatus());
    });
    let ownershipChecks = 0;
    fixture.consumer.isConnected.mockImplementation(() => {
      if (++ownershipChecks === 2) queueMicrotask(() => fixture.controller.abort());
      return true;
    });
    await runPulsarMetricStreamConsumer({ ...fixture.options, handleEvents: vi.fn() });
    expect(statuses).toEqual(["unavailable"]);
    expect(readiness.getStatus()).toBe("unavailable");
    expect(fixture.consumer.batchReceive).not.toHaveBeenCalled();
  });

  it("validates initial pending state before becoming ready and probes live ownership while idle", async () => {
    const fixture = input();
    const readiness = fixture.options.readiness;
    fixture.client.subscribe.mockImplementation(async () => {
      expect(readiness.getStatus()).toBe("starting");
      return fixture.consumer;
    });
    fixture.options.loadPendingGroup.mockImplementation(async () => {
      expect(readiness.getStatus()).toBe("starting");
      return null;
    });
    fixture.consumer.batchReceive.mockImplementation(async () => {
      expect(readiness.getStatus()).toBe("ready");
      fixture.consumer.isConnected.mockReturnValue(false);
      expect(readiness.getStatus()).toBe("unavailable");
      fixture.controller.abort();
      return [];
    });
    await runPulsarMetricStreamConsumer({ ...fixture.options, handleEvents: vi.fn() });
    expect(readiness.getStatus()).toBe("unavailable");
  });

  it("becomes unavailable immediately during pending subscribe and never readies its late result", async () => {
    const fixture = input();
    const readiness = fixture.options.readiness;
    let completeSubscription!: (consumer: typeof fixture.consumer) => void;
    const subscribed = new Promise<typeof fixture.consumer>((resolve) => {
      completeSubscription = resolve;
    });
    fixture.client.subscribe.mockReturnValue(subscribed);
    const markReady = vi.spyOn(readiness, "markReady");
    const running = runPulsarMetricStreamConsumer({ ...fixture.options, handleEvents: vi.fn() });
    fixture.controller.abort();
    const statusDuringSubscribe = readiness.getStatus();
    completeSubscription(fixture.consumer);
    await running;
    expect(statusDuringSubscribe).toBe("unavailable");
    expect(readiness.getStatus()).toBe("unavailable");
    expect(fixture.options.loadPendingGroup).not.toHaveBeenCalled();
    expect(fixture.consumer.batchReceive).not.toHaveBeenCalled();
    expect(fixture.consumer.close).toHaveBeenCalledOnce();
    expect(markReady).not.toHaveBeenCalled();
  });

  it("becomes unavailable on subscribe failure", async () => {
    const fixture = input();
    fixture.client.subscribe.mockRejectedValue(new Error("subscription failed"));
    await expect(
      runPulsarMetricStreamConsumer({ ...fixture.options, handleEvents: vi.fn() }),
    ).rejects.toThrow("subscription failed");
    expect(fixture.options.readiness.getStatus()).toBe("unavailable");
    expect(fixture.consumer.close).not.toHaveBeenCalled();
  });

  it("never marks ready when the initial pending descriptor fails validation", async () => {
    const fixture = input();
    const position = metricStreamPosition(
      { epoch: fixture.options.epoch, topic, partition: 2 },
      message(payload).getMessageId(),
    );
    fixture.options.loadPendingGroup.mockResolvedValue({
      ...describeAnalyticsDeliveryGroup([position], 500),
      memberCount: 501,
    });
    const markReady = vi.spyOn(fixture.options.readiness, "markReady");
    await expect(
      runPulsarMetricStreamConsumer({ ...fixture.options, handleEvents: vi.fn() }),
    ).rejects.toThrow(/pending.*configured bounds/i);
    expect(markReady).not.toHaveBeenCalled();
    expect(fixture.options.readiness.getStatus()).toBe("unavailable");
    expect(fixture.consumer.batchReceive).not.toHaveBeenCalled();
  });

  it("marks unavailable before closing after pending-state validation fails", async () => {
    const fixture = input();
    fixture.options.loadPendingGroup.mockRejectedValue(new Error("pending state unavailable"));
    fixture.consumer.close.mockImplementation(async () => {
      expect(fixture.options.readiness.getStatus()).toBe("unavailable");
      return null;
    });
    await expect(
      runPulsarMetricStreamConsumer({ ...fixture.options, handleEvents: vi.fn() }),
    ).rejects.toThrow("pending state unavailable");
    expect(fixture.consumer.acknowledge).not.toHaveBeenCalled();
  });

  it("marks unavailable before awaiting close after a ready handler fails", async () => {
    const fixture = input();
    fixture.consumer.batchReceive.mockResolvedValueOnce([message(payload)]);
    fixture.consumer.close.mockImplementation(async () => {
      expect(fixture.options.readiness.getStatus()).toBe("unavailable");
      return null;
    });
    await expect(
      runPulsarMetricStreamConsumer({
        ...fixture.options,
        handleEvents: async () => {
          expect(fixture.options.readiness.getStatus()).toBe("ready");
          throw new Error("durable handler failed");
        },
      }),
    ).rejects.toThrow("durable handler failed");
    expect(fixture.consumer.acknowledge).not.toHaveBeenCalled();
  });

  it("handles the concrete R1 topic without partitions without inventing a partition", async () => {
    const fixture = input();
    const concreteTopic = "persistent://public/default/sensor";
    const id = Pulsar.MessageId.deserialize(
      Buffer.from("080a100018ffffffffffffffffff012000", "hex"),
    );
    fixture.consumer.batchReceive.mockResolvedValueOnce([
      Object.assign(message(payload), {
        getTopicName: () => concreteTopic,
        getMessageId: () => id,
      }),
    ]);
    const handleEvents = vi.fn(
      async (_events: MetricStreamRedpandaEvent[], context: PulsarMetricStreamBatchContext) => {
        expect(context.positions).toEqual([
          {
            transport: "pulsar",
            epoch: "fixture-epoch",
            topic: concreteTopic,
            partition: -1,
            delivery: { major: "10", minor: "0", batch: 0 },
            serializedMessageId: id.serialize().toString("base64"),
          },
        ]);
      },
    );
    await runPulsarMetricStreamConsumer({
      ...fixture.options,
      topic: concreteTopic,
      partition: -1,
      handleEvents,
    });
    expect(handleEvents).toHaveBeenCalledTimes(1);
    expect(fixture.consumer.acknowledge).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed payloads without ACK or copying payload snippets into errors", async () => {
    const fixture = input();
    fixture.consumer.batchReceive.mockResolvedValueOnce([
      message(Buffer.from("private-health-payload")),
    ]);
    const handleEvents = vi.fn();
    await expect(
      runPulsarMetricStreamConsumer({ ...fixture.options, handleEvents }),
    ).rejects.toThrow("Malformed metric stream delivery");
    expect(handleEvents).not.toHaveBeenCalled();
    expect(fixture.consumer.acknowledge).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Malformed metric stream delivery" }),
      expect.objectContaining({
        tags: { metricStreamConsumer: "pulsar", metricStreamFailure: "intake" },
      }),
    );
  });

  it("fails a native batch above the admitted count before handling or ACK", async () => {
    const fixture = input();
    fixture.consumer.batchReceive.mockResolvedValueOnce(
      Array.from({ length: 21 }, (_, index) => message(payload, index)),
    );
    const handleEvents = vi.fn();
    await expect(
      runPulsarMetricStreamConsumer({ ...fixture.options, handleEvents }),
    ).rejects.toThrow(/native batch.*message bound/i);
    expect(handleEvents).not.toHaveBeenCalled();
    expect(fixture.consumer.acknowledge).not.toHaveBeenCalled();
    expect(fixture.consumer.close).toHaveBeenCalledTimes(1);
  });

  it("persists handling before individual ACK and preserves native delivery metadata", async () => {
    const fixture = input();
    const bytes = Buffer.from(payload);
    fixture.consumer.batchReceive.mockResolvedValue([message(bytes)]);
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
          properties: { "source.original-key": "original-key" },
          publishTimestamp: 1770000000123,
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
      batchReceivePolicy: { maxNumMessages: 20, maxNumBytes: 8 * 1024 * 1024, timeoutMs: 100 },
    });
    expect(fixture.consumer.close).toHaveBeenCalledTimes(1);
  });

  it("does not ACK a handler failure and closes intake instead of redelivery looping", async () => {
    const fixture = input();
    fixture.consumer.batchReceive.mockResolvedValue([message(payload)]);
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
    expect(fixture.consumer.batchReceive).toHaveBeenCalledTimes(1);
  });

  it("refuses ACK when connection ownership is lost during handling", async () => {
    const fixture = input();
    fixture.consumer.batchReceive.mockResolvedValue([message(payload)]);
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
    fixture.consumer.batchReceive.mockRejectedValue(new Error("broker unavailable"));
    await expect(
      runPulsarMetricStreamConsumer({ ...fixture.options, handleEvents: vi.fn() }),
    ).rejects.toThrow("broker unavailable");
    expect(fixture.consumer.batchReceive).toHaveBeenCalledTimes(1);
    expect(fixture.consumer.acknowledge).not.toHaveBeenCalled();
    expect(fixture.consumer.close).toHaveBeenCalledTimes(1);
  });

  it("stops a pending receive without dispatching or acknowledging after shutdown", async () => {
    const fixture = input();
    fixture.consumer.batchReceive.mockImplementation(() => {
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
    fixture.consumer.batchReceive.mockImplementation(() => {
      fixture.controller.abort();
      return new Promise<Message[]>(() => {});
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
    fixture.consumer.batchReceive.mockResolvedValue([message(payload)]);
    fixture.consumer.acknowledge.mockRejectedValue(new Error("ACK failed"));
    await expect(
      runPulsarMetricStreamConsumer({ ...fixture.options, handleEvents: vi.fn() }),
    ).rejects.toThrow("ACK failed");
    expect(fixture.consumer.batchReceive).toHaveBeenCalledTimes(1);
    expect(fixture.consumer.close).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, 19, 21])(
    "rejects invalid queue bound %s before subscribing",
    async (size) => {
      const fixture = input();
      await expect(
        runPulsarMetricStreamConsumer({
          ...fixture.options,
          receiverQueueSize: size,
          handleEvents: vi.fn(),
        }),
      ).rejects.toThrow(/queue/i);
      expect(fixture.client.subscribe).not.toHaveBeenCalled();
    },
  );

  it("accumulates500 actual messages across25 native batches before any individual ACK", async () => {
    const fixture = input();
    const originals = Array.from({ length: 500 }, (_, index) =>
      message(
        Buffer.from(
          JSON.stringify({
            ...event,
            id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          }),
        ),
        index,
      ),
    );
    for (let offset = 0; offset < originals.length; offset += 20)
      fixture.consumer.batchReceive.mockResolvedValueOnce(originals.slice(offset, offset + 20));
    fixture.consumer.acknowledge.mockImplementation(async (original) => {
      expect(fixture.trace).toContain("committed-500");
      expect(original).toBe(originals[fixture.trace.length - 1]);
      fixture.trace.push("ack");
      if (fixture.trace.length === 501) fixture.controller.abort();
      return null;
    });
    const handleEvents = vi.fn(
      async (events: MetricStreamRedpandaEvent[], context: PulsarMetricStreamBatchContext) => {
        expect(events).toHaveLength(500);
        expect(context.deliveries).toHaveLength(500);
        expect(context.positions).toHaveLength(500);
        expect(fixture.consumer.acknowledge).not.toHaveBeenCalled();
        expect(context.deliveries.map(({ data }) => data)).toEqual(
          originals.map((original) => original.getData()),
        );
        fixture.trace.push("committed-500");
      },
    );
    await runPulsarMetricStreamConsumer({
      ...fixture.options,
      maxGroupMessages: 500,
      handleEvents,
    });
    expect(handleEvents).toHaveBeenCalledTimes(1);
    expect(fixture.consumer.batchReceive).toHaveBeenCalledTimes(25);
    expect(fixture.consumer.acknowledge).toHaveBeenCalledTimes(500);
  });

  it("dispatches a sparse partial group after an empty timed native batch", async () => {
    const fixture = input();
    fixture.consumer.batchReceive
      .mockResolvedValueOnce([
        message(payload, 1),
        message(
          Buffer.from(JSON.stringify({ ...event, id: "10000000-0000-4000-8000-000000000002" })),
          2,
        ),
      ])
      .mockResolvedValueOnce([]);
    fixture.consumer.acknowledge.mockImplementation(async () => {
      fixture.trace.push("ack");
      if (fixture.trace.length === 2) fixture.controller.abort();
      return null;
    });
    const handleEvents = vi.fn(async (events: MetricStreamRedpandaEvent[]) => {
      expect(events).toHaveLength(2);
    });
    await runPulsarMetricStreamConsumer({
      ...fixture.options,
      maxGroupMessages: 500,
      handleEvents,
    });
    expect(fixture.consumer.batchReceive).toHaveBeenCalledTimes(2);
    expect(handleEvents).toHaveBeenCalledTimes(1);
  });

  it("retains native remainder across duplicate-source and control boundaries", async () => {
    const fixture = input();
    const marker = Buffer.from(
      JSON.stringify({
        version: 1,
        eventType: "metric_stream_batch_completed",
        operationId: "00000000-0000-4000-8000-000000000003",
        batchId: "batch",
        datasetKeys: ["metric_stream"],
        expectedEventCount: 1,
        partitionKey: "batch",
      }),
    );
    const last = Buffer.from(
      JSON.stringify({ ...event, id: "10000000-0000-4000-8000-000000000004" }),
    );
    fixture.consumer.batchReceive
      .mockResolvedValueOnce([
        message(payload, 1),
        message(payload, 2),
        message(marker, 3),
        message(last, 4),
      ])
      .mockResolvedValueOnce([]);
    fixture.consumer.acknowledge.mockImplementation(async () => {
      fixture.trace.push("ack");
      if (fixture.trace.length === 4) fixture.controller.abort();
      return null;
    });
    const groups: Buffer[][] = [];
    await runPulsarMetricStreamConsumer({
      ...fixture.options,
      maxGroupMessages: 500,
      handleEvents: async (_events, context) => {
        groups.push(context.deliveries.map(({ data }) => data));
      },
    });
    expect(groups).toEqual([[payload], [payload], [marker], [last]]);
    expect(fixture.consumer.batchReceive).toHaveBeenCalledTimes(2);
  });

  it("reassembles an exact pending range across native batches before the handler", async () => {
    const fixture = input();
    const originals = [1, 2, 3].map((index) =>
      message(
        Buffer.from(
          JSON.stringify({
            ...event,
            id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          }),
        ),
        index,
      ),
    );
    const positions = originals.map((original) =>
      metricStreamPosition(
        { epoch: fixture.options.epoch, topic, partition: 2 },
        original.getMessageId(),
      ),
    );
    const pending = describeAnalyticsDeliveryGroup(positions, 500);
    fixture.options.loadPendingGroup.mockResolvedValue(pending);
    fixture.consumer.batchReceive
      .mockResolvedValueOnce(originals.slice(0, 2))
      .mockResolvedValueOnce(originals.slice(2));
    fixture.consumer.acknowledge.mockImplementation(async () => {
      fixture.trace.push("ack");
      if (fixture.trace.length === 3) fixture.controller.abort();
      return null;
    });
    const handleEvents = vi.fn(
      async (_events: MetricStreamRedpandaEvent[], context: PulsarMetricStreamBatchContext) => {
        expect(describeAnalyticsDeliveryGroup(context.positions, 500)).toEqual(pending);
        expect(fixture.consumer.acknowledge).not.toHaveBeenCalled();
      },
    );
    await runPulsarMetricStreamConsumer({
      ...fixture.options,
      maxGroupMessages: 500,
      handleEvents,
    });
    expect(handleEvents).toHaveBeenCalledTimes(1);
  });

  it.each([
    "digest",
    "missing-first",
    "lowered-count",
    "lowered-bytes",
    "empty-before-complete",
    "overshoot",
  ])("fails pending%s without splitting or ACK", async (kind) => {
    const fixture = input();
    const originals = [1, 2, 3].map((index) =>
      message(
        Buffer.from(
          JSON.stringify({
            ...event,
            id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          }),
        ),
        index,
      ),
    );
    const positions = originals.map((original) =>
      metricStreamPosition(
        { epoch: fixture.options.epoch, topic, partition: 2 },
        original.getMessageId(),
      ),
    );
    const pending = describeAnalyticsDeliveryGroup(positions, 500);
    if (kind === "digest") pending.positionsDigest = "a".repeat(64);
    if (kind === "overshoot") originals[2] = message(originals[2]?.getData() ?? payload, 4);
    fixture.options.loadPendingGroup.mockResolvedValue(pending);
    fixture.consumer.batchReceive
      .mockResolvedValueOnce(
        kind === "missing-first"
          ? originals.slice(1)
          : kind === "empty-before-complete"
            ? originals.slice(0, 1)
            : originals,
      )
      .mockResolvedValue([]);
    const handleEvents = vi.fn();
    await expect(
      runPulsarMetricStreamConsumer({
        ...fixture.options,
        maxGroupMessages: kind === "lowered-count" ? 2 : 500,
        maxGroupBytes:
          kind === "lowered-bytes" ? payload.length + 256 : fixture.options.maxGroupBytes,
        handleEvents,
      }),
    ).rejects.toThrow(/pending|original configuration/i);
    expect(handleEvents).not.toHaveBeenCalled();
    expect(fixture.consumer.acknowledge).not.toHaveBeenCalled();
  });

  it("counts native property bytes before dispatch or ACK", async () => {
    const fixture = input();
    const original = message(payload, 1, { large: "x".repeat(2000) });
    fixture.consumer.batchReceive.mockResolvedValueOnce([original]);
    const handleEvents = vi.fn();
    await expect(
      runPulsarMetricStreamConsumer({ ...fixture.options, maxGroupBytes: 1024, handleEvents }),
    ).rejects.toThrow(/byte bound/);
    expect(handleEvents).not.toHaveBeenCalled();
    expect(fixture.consumer.acknowledge).not.toHaveBeenCalled();
  });

  it("processes completed prefix separately before exact pending reassembly", async () => {
    const fixture = input();
    const originals = [1, 2, 3].map((index) =>
      message(
        Buffer.from(
          JSON.stringify({
            ...event,
            id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          }),
        ),
        index,
      ),
    );
    const positions = originals.map((original) =>
      metricStreamPosition(
        { epoch: fixture.options.epoch, topic, partition: 2 },
        original.getMessageId(),
      ),
    );
    fixture.options.loadPendingGroup.mockResolvedValue(
      describeAnalyticsDeliveryGroup(positions.slice(1), 500),
    );
    fixture.consumer.batchReceive.mockResolvedValueOnce(originals);
    fixture.consumer.acknowledge.mockImplementation(async () => {
      fixture.trace.push("ack");
      if (fixture.trace.length === 3) fixture.controller.abort();
      return null;
    });
    const groups: number[] = [];
    await runPulsarMetricStreamConsumer({
      ...fixture.options,
      maxGroupMessages: 500,
      handleEvents: async (events) => {
        groups.push(events.length);
      },
    });
    expect(groups).toEqual([1, 2]);
    expect(fixture.consumer.batchReceive).toHaveBeenCalledTimes(1);
  });

  it("stops after a partial group ACK failure without repeating the durable handler", async () => {
    const fixture = input();
    fixture.consumer.batchReceive.mockResolvedValueOnce(
      [1, 2, 3].map((index) =>
        message(
          Buffer.from(
            JSON.stringify({
              ...event,
              id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            }),
          ),
          index,
        ),
      ),
    );
    fixture.consumer.acknowledge
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("second ACK failed"));
    const handleEvents = vi.fn();
    await expect(
      runPulsarMetricStreamConsumer({ ...fixture.options, maxGroupMessages: 3, handleEvents }),
    ).rejects.toThrow("second ACK failed");
    expect(handleEvents).toHaveBeenCalledTimes(1);
    expect(fixture.consumer.acknowledge).toHaveBeenCalledTimes(2);
    expect(fixture.consumer.batchReceive).toHaveBeenCalledTimes(1);
  });

  it.each([
    { nativeBatchMessages: 21 },
    { nativeBatchBytes: 0 },
    { maxGroupMessages: 501 },
    { maxGroupBytes: 8 * 1024 * 1024 + 1 },
  ])("rejects invalid explicit intake limits %j before subscribe", async (limits) => {
    const fixture = input();
    await expect(
      runPulsarMetricStreamConsumer({ ...fixture.options, ...limits, handleEvents: vi.fn() }),
    ).rejects.toThrow();
    expect(fixture.client.subscribe).not.toHaveBeenCalled();
  });
});
