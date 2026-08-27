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
const kafkaConsumerOn = vi.hoisted(() => vi.fn());
const kafkaConsumerSubscribe = vi.hoisted(() => vi.fn(async () => undefined));
const kafkaConsumerRun = vi.hoisted(() => vi.fn(async () => undefined));
const kafkaAdminConnect = vi.hoisted(() => vi.fn(async () => undefined));
const kafkaAdminCreateTopics = vi.hoisted(() => vi.fn(async () => true));
const kafkaAdminAlterConfigs = vi.hoisted(() => vi.fn(async () => undefined));
const kafkaAdminDisconnect = vi.hoisted(() => vi.fn(async () => undefined));
const kafkaProducerConnect = vi.hoisted(() => vi.fn(async () => undefined));
const kafkaProducerSend = vi.hoisted(() => vi.fn(async () => undefined));
const kafkaConsumerFactory = vi.hoisted(() =>
  vi.fn(() => ({
    connect: kafkaConsumerConnect,
    events: {
      CRASH: "consumer.crash",
      DISCONNECT: "consumer.disconnect",
      GROUP_JOIN: "consumer.group_join",
      REBALANCING: "consumer.rebalancing",
      STOP: "consumer.stop",
    },
    on: kafkaConsumerOn,
    subscribe: kafkaConsumerSubscribe,
    run: kafkaConsumerRun,
  })),
);
const kafkaConstructor = vi.hoisted(() =>
  vi.fn(
    class {
      constructor() {
        return {
          admin: () => ({
            alterConfigs: kafkaAdminAlterConfigs,
            connect: kafkaAdminConnect,
            createTopics: kafkaAdminCreateTopics,
            disconnect: kafkaAdminDisconnect,
          }),
          consumer: kafkaConsumerFactory,
          producer: () => ({ connect: kafkaProducerConnect, send: kafkaProducerSend }),
        };
      }
    },
  ),
);

vi.mock("kafkajs", () => ({
  default: {
    ConfigResourceTypes: { TOPIC: 2 },
  },
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

beforeEach(() => {
  captureException.mockClear();
  loggerError.mockClear();
});

describe("runMetricStreamEventConsumer", () => {
  it("subscribes to the metric stream topic and handles parsed events before resolving offsets", async () => {
    const connect = vi.fn(async () => undefined);
    const subscribe = vi.fn(async () => undefined);
    const resolveOffset = vi.fn();
    const heartbeat = vi.fn(async () => undefined);
    const commitOffsetsIfNecessary = vi.fn(async () => undefined);
    const handleEvents = vi.fn(async () => undefined);
    const quarantine = {
      connect: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
    };
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
      quarantine,
      topic: "metric-stream-v1",
    });

    expect(quarantine.connect).toHaveBeenCalledOnce();
    expect(quarantine.write).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith({ topic: "metric-stream-v1", fromBeginning: false });
    expect(handleEvents).toHaveBeenCalledWith([event], {
      topic: "metric-stream-v1",
      partition: 2,
      eventOffsets: ["12"],
      heartbeat,
    });
    expect(resolveOffset).toHaveBeenCalledWith("12");
    expect(commitOffsetsIfNecessary).toHaveBeenCalled();
  });

  it("registers a supplied lifecycle listener before consuming events", async () => {
    const observeGroupLifecycle = vi.fn();
    const lifecycleListener = {
      markGroupJoined: vi.fn(),
      markUnavailable: vi.fn(),
    };
    const consumer = {
      connect: vi.fn(async () => undefined),
      observeGroupLifecycle,
      subscribe: vi.fn(async () => undefined),
      run: vi.fn(async () => undefined),
    };

    await runMetricStreamEventConsumer({
      consumer,
      handleEvents: vi.fn(async () => undefined),
      lifecycleListener,
      quarantine: {
        connect: vi.fn(async () => undefined),
        write: vi.fn(async () => undefined),
      },
      topic: "metric-stream-v1",
    });

    expect(observeGroupLifecycle).toHaveBeenCalledWith(lifecycleListener);
    expect(observeGroupLifecycle.mock.invocationCallOrder[0]).toBeLessThan(
      consumer.run.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("does not register the consumer lifecycle observer without a listener", async () => {
    const observeGroupLifecycle = vi.fn();
    const consumer = {
      connect: vi.fn(async () => undefined),
      observeGroupLifecycle,
      subscribe: vi.fn(async () => undefined),
      run: vi.fn(async () => undefined),
    };

    await runMetricStreamEventConsumer({
      consumer,
      handleEvents: vi.fn(async () => undefined),
      quarantine: {
        connect: vi.fn(async () => undefined),
        write: vi.fn(async () => undefined),
      },
      topic: "metric-stream-v1",
    });

    expect(observeGroupLifecycle).not.toHaveBeenCalled();
  });

  it("passes delete events to sinks in Redpanda batch order", async () => {
    const deleteEvent = createMetricStreamDeletedEvent(
      { activityId: "20000000-0000-4000-8000-000000000001" },
      operationRevision,
    );
    const handleEvents = vi.fn(async () => undefined);
    const heartbeat = vi.fn(async () => undefined);
    const quarantine = {
      connect: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
    };
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
          heartbeat,
          resolveOffset: vi.fn(),
        });
      }),
    };

    await runMetricStreamEventConsumer({
      consumer,
      handleEvents,
      quarantine,
      topic: "metric-stream-v1",
    });

    expect(handleEvents).toHaveBeenCalledWith([deleteEvent, event], {
      topic: "metric-stream-v1",
      partition: 2,
      eventOffsets: ["20", "21"],
      heartbeat,
    });
  });

  it("does not resolve offsets when the handler fails", async () => {
    const resolveOffset = vi.fn();
    const handleEvents = vi.fn(async () => {
      throw new Error("sink failed");
    });
    const quarantine = {
      connect: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
    };
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
        quarantine,
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
    const quarantine = {
      connect: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
    };
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
      quarantine,
      topic: "metric-stream-v1",
    });

    expect(handleEvents).not.toHaveBeenCalled();
    expect(quarantine.write).not.toHaveBeenCalled();
    expect(resolveOffset).toHaveBeenCalledWith("13");
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(commitOffsetsIfNecessary).toHaveBeenCalledOnce();
  });

  it("leaves the complete batch uncommitted when durable quarantine fails", async () => {
    const resolveOffset = vi.fn();
    const handleEvents = vi.fn(async () => undefined);
    const commitOffsetsIfNecessary = vi.fn(async () => undefined);
    const heartbeat = vi.fn(async () => undefined);
    const quarantineError = new Error("quarantine unavailable");
    const quarantine = {
      connect: vi.fn(async () => undefined),
      write: vi.fn(async () => {
        throw quarantineError;
      }),
    };
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

    await expect(
      runMetricStreamEventConsumer({
        consumer,
        handleEvents,
        quarantine,
        topic: "metric-stream-v1",
      }),
    ).rejects.toThrow("quarantine unavailable");

    expect(handleEvents).not.toHaveBeenCalled();
    expect(quarantine.write).toHaveBeenCalledWith({
      error: expect.anything(),
      offset: "14",
      partition: 2,
      payload: Buffer.from("{not-json"),
      topic: "metric-stream-v1",
    });
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("Rejecting malformed Redpanda message at offset 14"),
    );
    expect(captureException).toHaveBeenCalledWith(
      expect.any(SyntaxError),
      expect.objectContaining({
        extra: {
          offset: "14",
          valueBytes: Buffer.byteLength("{not-json"),
        },
        tags: expect.objectContaining({
          metricStreamFailure: "malformed-message",
        }),
      }),
    );
    expect(resolveOffset).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    expect(commitOffsetsIfNecessary).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(quarantineError, {
      extra: {
        offset: "14",
        partition: 2,
        topic: "metric-stream-v1",
        valueBytes: Buffer.byteLength("{not-json"),
      },
      tags: {
        metricStreamConsumer: "redpanda",
        metricStreamFailure: "quarantine-write",
      },
    });
  });

  it("does not let a later valid message bypass an earlier unhandled offset", async () => {
    const resolveOffset = vi.fn();
    const handleEvents = vi.fn(async () => undefined);
    const quarantine = {
      connect: vi.fn(async () => undefined),
      write: vi.fn(async () => {
        throw new Error("quarantine unavailable");
      }),
    };
    const consumer = {
      connect: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => undefined),
      run: vi.fn(async (options) => {
        await options.eachBatch({
          batch: {
            topic: "metric-stream-v1",
            partition: 2,
            messages: [
              { offset: "14", value: Buffer.from("{not-json") },
              { offset: "15", value: Buffer.from(JSON.stringify(event)) },
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
        quarantine,
        topic: "metric-stream-v1",
      }),
    ).rejects.toThrow("quarantine unavailable");

    expect(handleEvents).not.toHaveBeenCalled();
    expect(resolveOffset).not.toHaveBeenCalled();
  });

  it("writes malformed payloads durably before handling later events and committing", async () => {
    const order: string[] = [];
    const resolveOffset = vi.fn((offset: string) => order.push(`resolve:${offset}`));
    const heartbeat = vi.fn(async () => undefined);
    const handleEvents = vi.fn(async () => {
      order.push("handle");
    });
    const quarantine = {
      connect: vi.fn(async () => undefined),
      write: vi.fn(async () => {
        order.push("quarantine");
      }),
    };
    const consumer = {
      connect: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => undefined),
      run: vi.fn(async (options) => {
        await options.eachBatch({
          batch: {
            topic: "metric-stream-v1",
            partition: 2,
            messages: [
              { offset: "14", value: Buffer.from("{not-json") },
              { offset: "15", value: Buffer.from(JSON.stringify(event)) },
            ],
          },
          commitOffsetsIfNecessary: vi.fn(async () => {
            order.push("commit");
          }),
          heartbeat,
          resolveOffset,
        });
      }),
    };

    await runMetricStreamEventConsumer({
      consumer,
      handleEvents,
      quarantine,
      topic: "metric-stream-v1",
    });

    expect(quarantine.write).toHaveBeenCalledWith({
      error: expect.anything(),
      offset: "14",
      partition: 2,
      payload: Buffer.from("{not-json"),
      topic: "metric-stream-v1",
    });
    expect(handleEvents).toHaveBeenCalledWith([event], {
      topic: "metric-stream-v1",
      partition: 2,
      eventOffsets: ["15"],
      heartbeat,
    });
    expect(order).toEqual(["quarantine", "handle", "resolve:14", "resolve:15", "commit"]);
  });
});

describe("createKafkaMetricStreamConsumerFromEnv", () => {
  beforeEach(() => {
    kafkaConstructor.mockClear();
    kafkaConsumerFactory.mockClear();
    kafkaConsumerConnect.mockClear();
    kafkaConsumerOn.mockClear();
    kafkaConsumerSubscribe.mockClear();
    kafkaConsumerRun.mockClear();
    kafkaAdminConnect.mockClear();
    kafkaAdminCreateTopics.mockClear();
    kafkaAdminAlterConfigs.mockClear();
    kafkaAdminDisconnect.mockClear();
    kafkaProducerConnect.mockClear();
    kafkaProducerSend.mockClear();
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
    const { consumer, quarantine, topic } = createKafkaMetricStreamConsumerFromEnv(
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

    await quarantine.connect();
    expect(kafkaAdminCreateTopics).toHaveBeenCalledWith({
      topics: [
        {
          configEntries: [
            { name: "cleanup.policy", value: "delete" },
            { name: "retention.ms", value: "604800000" },
            { name: "retention.bytes", value: "1073741824" },
          ],
          topic: "metric-stream-v1.quarantine.v1",
        },
      ],
      waitForLeaders: true,
    });
    expect(kafkaAdminAlterConfigs).toHaveBeenCalledWith({
      resources: [
        {
          configEntries: [
            { name: "cleanup.policy", value: "delete" },
            { name: "retention.ms", value: "604800000" },
            { name: "retention.bytes", value: "1073741824" },
          ],
          name: "metric-stream-v1.quarantine.v1",
          type: 2,
        },
      ],
    });
    expect(kafkaProducerConnect).toHaveBeenCalledOnce();
  });

  it("forwards Kafka group lifecycle events to sink readiness", () => {
    const { consumer } = createKafkaMetricStreamConsumerFromEnv("metric-stream-clickhouse-sink", {
      METRIC_STREAM_TOPIC: "metric-stream-v1",
      REDPANDA_BROKERS: "redpanda:9092",
    });
    const readiness = {
      markGroupJoined: vi.fn(),
      markUnavailable: vi.fn(),
    };

    consumer.observeGroupLifecycle?.(readiness);

    expect(kafkaConsumerOn).toHaveBeenCalledWith("consumer.group_join", expect.any(Function));
    expect(kafkaConsumerOn).toHaveBeenCalledWith("consumer.rebalancing", expect.any(Function));
    expect(kafkaConsumerOn).toHaveBeenCalledWith("consumer.disconnect", expect.any(Function));
    expect(kafkaConsumerOn).toHaveBeenCalledWith("consumer.stop", expect.any(Function));
    expect(kafkaConsumerOn).toHaveBeenCalledWith("consumer.crash", expect.any(Function));

    const groupJoinListener = kafkaConsumerOn.mock.calls.find(
      ([eventName]) => eventName === "consumer.group_join",
    )?.[1];
    const unavailableListeners = kafkaConsumerOn.mock.calls
      .filter(
        ([eventName]) =>
          eventName === "consumer.rebalancing" ||
          eventName === "consumer.disconnect" ||
          eventName === "consumer.stop" ||
          eventName === "consumer.crash",
      )
      .map(([, listener]) => listener);
    if (
      typeof groupJoinListener !== "function" ||
      unavailableListeners.length !== 4 ||
      unavailableListeners.some((listener) => typeof listener !== "function")
    ) {
      throw new Error("expected Kafka lifecycle listeners");
    }

    groupJoinListener();
    for (const unavailableListener of unavailableListeners) {
      unavailableListener();
    }

    expect(readiness.markGroupJoined).toHaveBeenCalledOnce();
    expect(readiness.markUnavailable).toHaveBeenCalledTimes(4);
  });
});
