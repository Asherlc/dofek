import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMetricStreamDeletedEvent, createMetricStreamEvent } from "./events.ts";
import {
  createKafkaMetricStreamConsumerFromEnv,
  runMetricStreamEventConsumer,
} from "./redpanda-consumer.ts";

const captureException = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
const operationRevision = "1000000000000000";
const kafkaConsumerConnect = vi.hoisted(() => vi.fn(async () => undefined));
const kafkaConsumerSubscribe = vi.hoisted(() => vi.fn(async () => undefined));
const kafkaConsumerRun = vi.hoisted(() => vi.fn(async () => undefined));
const kafkaConsumerFactory = vi.hoisted(() =>
  vi.fn(() => ({
    connect: kafkaConsumerConnect,
    subscribe: kafkaConsumerSubscribe,
    run: kafkaConsumerRun,
  })),
);
const kafkaConstructor = vi.hoisted(() =>
  vi.fn(() => ({
    consumer: kafkaConsumerFactory,
  })),
);

vi.mock("kafkajs", () => ({
  Kafka: kafkaConstructor,
}));
vi.mock("@sentry/node", () => ({
  captureException,
}));
vi.mock("../logger.ts", () => ({
  logger: {
    error: loggerError,
  },
}));

const event = createMetricStreamEvent(
  {
    id: "10000000-0000-4000-8000-000000000001",
    recordedAt: "2026-06-06T19:00:00.000Z",
    userId: "00000000-0000-0000-0000-000000000001",
    providerId: "apple_health",
    externalId: "hk:heart-rate-1",
    deviceId: "Apple Watch",
    sourceType: "api",
    channel: "heart_rate",
    scalar: 72,
  },
  operationRevision,
);

describe("runMetricStreamEventConsumer", () => {
  it("subscribes to the metric stream topic and handles parsed events before resolving offsets", async () => {
    const connect = vi.fn(async () => undefined);
    const subscribe = vi.fn(async () => undefined);
    const resolveOffset = vi.fn();
    const heartbeat = vi.fn(async () => undefined);
    const commitOffsetsIfNecessary = vi.fn(async () => undefined);
    const handleEvents = vi.fn(async () => undefined);
    const consumer = {
      connect,
      subscribe,
      run: vi.fn(async (options) => {
        await options.eachBatch({
          batch: {
            topic: "metric-stream-v1",
            partition: 2,
            messages: [
              {
                offset: "12",
                value: Buffer.from(JSON.stringify(event)),
              },
            ],
          },
          commitOffsetsIfNecessary,
          heartbeat,
          resolveOffset,
        });
      }),
    };

    await runMetricStreamEventConsumer({
      consumer,
      handleEvents,
      topic: "metric-stream-v1",
    });

    expect(connect).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith({ topic: "metric-stream-v1", fromBeginning: false });
    expect(handleEvents).toHaveBeenCalledWith([event], {
      topic: "metric-stream-v1",
      partition: 2,
      eventOffsets: ["12"],
    });
    expect(resolveOffset).toHaveBeenCalledWith("12");
    expect(commitOffsetsIfNecessary).toHaveBeenCalled();
  });

  it("passes delete events to sinks in Redpanda batch order", async () => {
    const deleteEvent = createMetricStreamDeletedEvent(
      { activityId: "20000000-0000-4000-8000-000000000001" },
      operationRevision,
    );
    const handleEvents = vi.fn(async () => undefined);
    const consumer = {
      connect: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => undefined),
      run: vi.fn(async (options) => {
        await options.eachBatch({
          batch: {
            topic: "metric-stream-v1",
            partition: 2,
            messages: [
              {
                offset: "20",
                value: Buffer.from(JSON.stringify(deleteEvent)),
              },
              {
                offset: "21",
                value: Buffer.from(JSON.stringify(event)),
              },
            ],
          },
          commitOffsetsIfNecessary: vi.fn(async () => undefined),
          heartbeat: vi.fn(async () => undefined),
          resolveOffset: vi.fn(),
        });
      }),
    };

    await runMetricStreamEventConsumer({
      consumer,
      handleEvents,
      topic: "metric-stream-v1",
    });

    expect(handleEvents).toHaveBeenCalledWith([deleteEvent, event], {
      topic: "metric-stream-v1",
      partition: 2,
      eventOffsets: ["20", "21"],
    });
  });

  it("does not resolve offsets when the handler fails", async () => {
    const resolveOffset = vi.fn();
    const handleEvents = vi.fn(async () => {
      throw new Error("sink failed");
    });
    const consumer = {
      connect: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => undefined),
      run: vi.fn(async (options) => {
        await options.eachBatch({
          batch: {
            topic: "metric-stream-v1",
            partition: 2,
            messages: [
              {
                offset: "12",
                value: Buffer.from(JSON.stringify(event)),
              },
            ],
          },
          commitOffsetsIfNecessary: vi.fn(async () => undefined),
          heartbeat: vi.fn(async () => undefined),
          resolveOffset,
        });
      }),
    };

    await expect(
      runMetricStreamEventConsumer({
        consumer,
        handleEvents,
        topic: "metric-stream-v1",
      }),
    ).rejects.toThrow("sink failed");

    expect(resolveOffset).not.toHaveBeenCalled();
  });

  it("skips tombstone messages and does not call the handler for empty batches", async () => {
    const resolveOffset = vi.fn();
    const handleEvents = vi.fn(async () => undefined);
    const commitOffsetsIfNecessary = vi.fn(async () => undefined);
    const heartbeat = vi.fn(async () => undefined);
    const consumer = {
      connect: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => undefined),
      run: vi.fn(async (options) => {
        expect(options.eachBatchAutoResolve).toBe(false);
        await options.eachBatch({
          batch: {
            topic: "metric-stream-v1",
            partition: 2,
            messages: [{ offset: "13", value: null }],
          },
          commitOffsetsIfNecessary,
          heartbeat,
          resolveOffset,
        });
      }),
    };

    await runMetricStreamEventConsumer({
      consumer,
      handleEvents,
      topic: "metric-stream-v1",
    });

    expect(handleEvents).not.toHaveBeenCalled();
    expect(resolveOffset).toHaveBeenCalledWith("13");
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(commitOffsetsIfNecessary).toHaveBeenCalledOnce();
  });

  it("reports malformed messages and still commits the batch offset", async () => {
    const resolveOffset = vi.fn();
    const handleEvents = vi.fn(async () => undefined);
    const commitOffsetsIfNecessary = vi.fn(async () => undefined);
    const heartbeat = vi.fn(async () => undefined);
    const consumer = {
      connect: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => undefined),
      run: vi.fn(async (options) => {
        await options.eachBatch({
          batch: {
            topic: "metric-stream-v1",
            partition: 2,
            messages: [{ offset: "14", value: Buffer.from("{not-json") }],
          },
          commitOffsetsIfNecessary,
          heartbeat,
          resolveOffset,
        });
      }),
    };

    await runMetricStreamEventConsumer({
      consumer,
      handleEvents,
      topic: "metric-stream-v1",
    });

    expect(handleEvents).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("Skipping malformed Redpanda message at offset 14"),
    );
    expect(captureException).toHaveBeenCalledOnce();
    expect(resolveOffset).toHaveBeenCalledWith("14");
    expect(commitOffsetsIfNecessary).toHaveBeenCalledOnce();
  });
});

describe("createKafkaMetricStreamConsumerFromEnv", () => {
  beforeEach(() => {
    kafkaConstructor.mockClear();
    kafkaConsumerFactory.mockClear();
    kafkaConsumerConnect.mockClear();
    kafkaConsumerSubscribe.mockClear();
    kafkaConsumerRun.mockClear();
  });

  it("requires Redpanda brokers", () => {
    expect(() =>
      createKafkaMetricStreamConsumerFromEnv("metric-stream-clickhouse-sink", {
        METRIC_STREAM_TOPIC: "metric-stream-v1",
      }),
    ).toThrow("REDPANDA_BROKERS is required");
  });

  it("requires a metric stream topic", () => {
    expect(() =>
      createKafkaMetricStreamConsumerFromEnv("metric-stream-clickhouse-sink", {
        REDPANDA_BROKERS: "redpanda:9092",
      }),
    ).toThrow("METRIC_STREAM_TOPIC is required");
  });

  it("rejects broker lists that only contain separators and whitespace", () => {
    expect(() =>
      createKafkaMetricStreamConsumerFromEnv("metric-stream-clickhouse-sink", {
        METRIC_STREAM_TOPIC: "metric-stream-v1",
        REDPANDA_BROKERS: " , ",
      }),
    ).toThrow("REDPANDA_BROKERS must contain at least one broker");
  });

  it("trims broker lists and adapts KafkaJS consumer methods", async () => {
    const { consumer, topic } = createKafkaMetricStreamConsumerFromEnv(
      "metric-stream-clickhouse-sink",
      {
        METRIC_STREAM_TOPIC: "metric-stream-v1",
        REDPANDA_BROKERS: " redpanda:9092 , redpanda:9093 ",
      },
    );

    expect(topic).toBe("metric-stream-v1");
    expect(kafkaConstructor).toHaveBeenCalledWith({
      brokers: ["redpanda:9092", "redpanda:9093"],
      clientId: "dofek-metric-stream-consumer",
    });
    expect(kafkaConsumerFactory).toHaveBeenCalledWith({ groupId: "metric-stream-clickhouse-sink" });

    await consumer.connect();
    await consumer.subscribe({ topic: "metric-stream-v1", fromBeginning: false });
    await consumer.run({
      eachBatchAutoResolve: false,
      eachBatch: async () => undefined,
    });

    expect(kafkaConsumerConnect).toHaveBeenCalledOnce();
    expect(kafkaConsumerSubscribe).toHaveBeenCalledWith({
      topic: "metric-stream-v1",
      fromBeginning: false,
    });
    expect(kafkaConsumerRun).toHaveBeenCalledWith({
      eachBatchAutoResolve: false,
      eachBatch: expect.any(Function),
    });
  });
});
