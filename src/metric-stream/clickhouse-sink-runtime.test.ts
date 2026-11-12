import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricStreamConsumerReadiness } from "./consumer-readiness.ts";
import type { MetricStreamEventV1 } from "./events.ts";
import type { RunMetricStreamEventConsumerOptions } from "./redpanda-consumer.ts";

const captureException = vi.hoisted(() => vi.fn());

vi.mock("../lib/error-reporting.ts", () => ({ captureException }));

const heartRateEvent = {
  version: 1,
  id: "10000000-0000-4000-8000-000000000001",
  recordedAt: "2026-06-06T19:00:00.000Z",
  userId: "00000000-0000-4000-8000-000000000001",
  providerId: "apple_health",
  generation: 0,
  externalId: "hk:heart-rate-1",
  deviceId: "Apple Watch",
  sourceType: "api",
  channel: "heart_rate",
  activityId: null,
  scalar: 72,
  vector: null,
  point: null,
  metadata: null,
} satisfies MetricStreamEventV1;

const imuEvent = {
  ...heartRateEvent,
  id: "10000000-0000-4000-8000-000000000002",
  channel: "imu",
} satisfies MetricStreamEventV1;

function makeEmptyGenerationQuery() {
  return vi.fn(async () => ({ json: async () => [] }));
}

afterEach(() => {
  vi.useRealTimers();
  captureException.mockClear();
  vi.doUnmock("../db/clickhouse.ts");
  vi.doUnmock("../db/index.ts");
  vi.doUnmock("../analytics/analytics-query-owner.ts");
  vi.doUnmock("./consumer-readiness.ts");
  vi.doUnmock("./redpanda-consumer.ts");
  vi.resetModules();
});

describe("runMetricStreamClickHouseSinkFromEnv", () => {
  beforeEach(() => {
    vi.doMock("../db/index.ts", () => ({
      createDatabaseFromEnv: () => ({ $client: { end: vi.fn(async () => undefined) } }),
    }));
    vi.doMock("../analytics/analytics-query-owner.ts", () => ({
      ANALYTICS_PUBLICATION_RESOURCE: "metric-stream-source",
      withAnalyticsQueryOwner: async (
        _database: unknown,
        client: unknown,
        _input: unknown,
        operation: (owner: { client: unknown }) => Promise<unknown>,
      ) => operation({ client }),
    }));
  });
  it("drains an active owned batch before disconnecting sink dependencies on shutdown", async () => {
    vi.resetModules();
    let markInsertEntered!: () => void;
    const insertEntered = new Promise<void>((resolve) => {
      markInsertEntered = resolve;
    });
    let releaseOwnedInsert!: () => void;
    const ownedInsertHold = new Promise<void>((resolve) => {
      releaseOwnedInsert = resolve;
    });
    const lifecycleOrder: string[] = [];
    let activeBatch: Promise<void> | undefined;
    let sinkOptions: RunMetricStreamEventConsumerOptions | undefined;
    const ownedClient = {
      insert: vi.fn(async () => {
        markInsertEntered();
        await ownedInsertHold;
      }),
      query: makeEmptyGenerationQuery(),
    };
    const database = {
      $client: {
        end: vi.fn(async () => {
          lifecycleOrder.push("database-end");
        }),
      },
    };
    const clickHouse = {
      insert: vi.fn(async () => undefined),
      query: makeEmptyGenerationQuery(),
      close: vi.fn(async () => {
        lifecycleOrder.push("clickhouse-close");
      }),
    };
    const consumer = {
      connect: vi.fn(async () => undefined),
      observeGroupLifecycle: vi.fn(),
      subscribe: vi.fn(async () => undefined),
      run: vi.fn(async () => undefined),
      stop: vi.fn(async () => {
        lifecycleOrder.push("consumer-stop");
        await activeBatch;
      }),
      disconnect: vi.fn(async () => {
        lifecycleOrder.push("consumer-disconnect");
      }),
    };
    const quarantine = {
      connect: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => {
        lifecycleOrder.push("quarantine-disconnect");
      }),
    };
    const runConsumer = vi.fn(async (options: RunMetricStreamEventConsumerOptions) => {
      sinkOptions = options;
    });
    vi.doMock("../db/clickhouse.ts", () => ({ createClickHouseClientFromEnv: () => clickHouse }));
    vi.doMock("../db/index.ts", () => ({ createDatabaseFromEnv: () => database }));
    vi.doMock("../analytics/analytics-query-owner.ts", () => ({
      ANALYTICS_PUBLICATION_RESOURCE: "metric-stream-source",
      withAnalyticsQueryOwner: async (
        _database: unknown,
        _client: unknown,
        _input: unknown,
        operation: (owner: { client: typeof ownedClient }) => Promise<void>,
      ) => {
        try {
          return await operation({ client: ownedClient });
        } finally {
          lifecycleOrder.push("owner-release");
        }
      },
    }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv: () => ({
        consumer,
        quarantine,
        topic: "metric-stream-v1",
      }),
      runMetricStreamEventConsumer: runConsumer,
    }));

    const { runMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink-runtime.ts");
    const readiness = new MetricStreamConsumerReadiness();
    const sigtermHandlerCount = process.listenerCount("SIGTERM");
    const sigintHandlerCount = process.listenerCount("SIGINT");
    const running = runMetricStreamClickHouseSinkFromEnv(readiness);
    try {
      await vi.waitFor(() => expect(sinkOptions).toBeDefined());
      const batch = sinkOptions?.handleEvents([heartRateEvent], {
        topic: "metric-stream-v1",
        partition: 0,
        eventOffsets: ["42"],
        heartbeat: vi.fn(async () => undefined),
      });
      if (!batch) throw new Error("Sink callback was not installed");
      activeBatch = batch;
      await insertEntered;

      process.emit("SIGTERM");
      process.emit("SIGINT");
      await vi.waitFor(() => expect(consumer.stop).toHaveBeenCalledOnce());
      expect(readiness.getStatus()).toBe("unavailable");
      expect(database.$client.end).not.toHaveBeenCalled();
      expect(clickHouse.close).not.toHaveBeenCalled();
      expect(consumer.disconnect).not.toHaveBeenCalled();
      expect(quarantine.disconnect).not.toHaveBeenCalled();

      releaseOwnedInsert();
      await running;
      expect(ownedClient.insert).toHaveBeenCalledOnce();
      expect(consumer.disconnect).toHaveBeenCalledOnce();
      expect(quarantine.disconnect).toHaveBeenCalledOnce();
      expect(database.$client.end).toHaveBeenCalledOnce();
      expect(clickHouse.close).toHaveBeenCalledOnce();
      const ownerReleaseIndex = lifecycleOrder.indexOf("owner-release");
      for (const teardown of [
        "consumer-disconnect",
        "quarantine-disconnect",
        "database-end",
        "clickhouse-close",
      ]) {
        expect(ownerReleaseIndex).toBeGreaterThanOrEqual(0);
        expect(ownerReleaseIndex).toBeLessThan(lifecycleOrder.indexOf(teardown));
      }
      expect(process.listenerCount("SIGTERM")).toBe(sigtermHandlerCount);
      expect(process.listenerCount("SIGINT")).toBe(sigintHandlerCount);
    } finally {
      releaseOwnedInsert();
      process.emit("SIGTERM");
      await activeBatch?.catch(() => undefined);
      await running.catch(() => undefined);
    }
  });
  it("admits publication before batch effects and keeps heartbeats active while waiting", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const raw = {
      insert: vi.fn(async () => undefined),
      query: makeEmptyGenerationQuery(),
      close: vi.fn(async () => undefined),
    };
    const owned = { insert: vi.fn(async () => undefined), query: makeEmptyGenerationQuery() };
    const database = { $client: { end: vi.fn(async () => undefined) } };
    const withOwner = vi.fn(
      async (
        _database: unknown,
        _client: unknown,
        _input: { resourceId: string; intentId: string },
        operation: (owner: { client: typeof owned }) => Promise<unknown>,
      ) => {
        await held;
        return operation({ client: owned });
      },
    );
    const runConsumer = vi.fn(async (_options: RunMetricStreamEventConsumerOptions) => undefined);
    vi.doMock("../db/clickhouse.ts", () => ({ createClickHouseClientFromEnv: () => raw }));
    vi.doMock("../db/index.ts", () => ({ createDatabaseFromEnv: () => database }));
    vi.doMock("../analytics/analytics-query-owner.ts", () => ({
      ANALYTICS_PUBLICATION_RESOURCE: "metric-stream-source",
      withAnalyticsQueryOwner: withOwner,
    }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv: () => ({
        consumer: {
          observeGroupLifecycle: vi.fn(),
          stop: vi.fn(async () => undefined),
          disconnect: vi.fn(async () => undefined),
        },
        quarantine: { disconnect: vi.fn(async () => undefined) },
        topic: "metric-stream-v1",
      }),
      runMetricStreamEventConsumer: runConsumer,
    }));
    const { runMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink-runtime.ts");
    const running = runMetricStreamClickHouseSinkFromEnv(new MetricStreamConsumerReadiness());
    await vi.waitFor(() => expect(runConsumer).toHaveBeenCalledOnce());
    const options = runConsumer.mock.calls[0]?.[0];
    if (!options) throw new Error("Missing actual sink callback");
    const context = {
      topic: "metric-stream-v1",
      partition: 0,
      eventOffsets: ["42"],
      heartbeat: vi.fn(async () => undefined),
    };
    const pending = options.handleEvents([heartRateEvent], context);
    try {
      expect(withOwner).toHaveBeenCalledOnce();
      expect(owned.insert).not.toHaveBeenCalled();
      expect(raw.insert).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3000);
      expect(context.heartbeat).toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
    expect(owned.insert).toHaveBeenCalledOnce();
    expect(raw.insert).not.toHaveBeenCalled();
    expect(database.$client.end).not.toHaveBeenCalled();
    expect(raw.close).not.toHaveBeenCalled();
    await options.handleEvents([heartRateEvent, imuEvent], {
      ...context,
      eventOffsets: ["42", "43"],
    });
    expect(withOwner.mock.calls[1]?.[2].intentId).toBe(withOwner.mock.calls[0]?.[2].intentId);
    await options.handleEvents([heartRateEvent], { ...context, eventOffsets: ["43"] });
    expect(withOwner.mock.calls[2]?.[2].intentId).not.toBe(withOwner.mock.calls[0]?.[2].intentId);
    process.emit("SIGTERM");
    await running;
  });
  it("consumes Redpanda events and inserts them into ClickHouse", async () => {
    const client = {
      insert: vi.fn(async () => undefined),
      query: makeEmptyGenerationQuery(),
      close: vi.fn(async () => undefined),
    };
    const consumer = {
      connect: vi.fn(async () => undefined),
      observeGroupLifecycle: vi.fn(),
      subscribe: vi.fn(async () => undefined),
      run: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
    };
    const runMetricStreamEventConsumer = vi.fn(
      async (_options: RunMetricStreamEventConsumerOptions) => undefined,
    );
    const createKafkaMetricStreamConsumerFromEnv = vi.fn(() => ({
      consumer,
      quarantine: {
        connect: vi.fn(async () => undefined),
        write: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
      },
      topic: "metric-stream-v1",
    }));

    vi.doMock("../db/clickhouse.ts", () => ({
      createClickHouseClientFromEnv: vi.fn(() => client),
    }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv,
      runMetricStreamEventConsumer,
    }));

    const { runMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink-runtime.ts");

    const running = runMetricStreamClickHouseSinkFromEnv(new MetricStreamConsumerReadiness());
    await vi.waitFor(() => expect(runMetricStreamEventConsumer).toHaveBeenCalledOnce());

    expect(createKafkaMetricStreamConsumerFromEnv).toHaveBeenCalledWith();
    expect(runMetricStreamEventConsumer).toHaveBeenCalledWith({
      consumer,
      quarantine: expect.any(Object),
      topic: "metric-stream-v1",
      lifecycleListener: expect.any(Object),
      handleEvents: expect.any(Function),
    });

    const options = runMetricStreamEventConsumer.mock.calls[0]?.[0];
    if (!options) {
      throw new Error("expected consumer options");
    }
    await options.handleEvents([heartRateEvent], {
      topic: "metric-stream-v1",
      partition: 2,
      eventOffsets: ["42"],
      heartbeat: vi.fn(async () => undefined),
    });
    expect(client.insert).toHaveBeenCalledOnce();
    process.emit("SIGTERM");
    await running;
  });

  it("requires an insert-capable ClickHouse client", async () => {
    vi.doMock("../db/clickhouse.ts", () => ({
      createClickHouseClientFromEnv: vi.fn(() => ({})),
    }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv: vi.fn(),
      runMetricStreamEventConsumer: vi.fn(),
    }));

    const { runMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink-runtime.ts");

    await expect(
      runMetricStreamClickHouseSinkFromEnv(new MetricStreamConsumerReadiness()),
    ).rejects.toThrow("ClickHouse metric-stream sink requires an insert-capable client");
  });

  it("closes its database and ClickHouse client when consumer startup fails", async () => {
    const failure = new Error("Consumer startup failed");
    const end = vi.fn(async () => undefined),
      close = vi.fn(async () => undefined);
    vi.doMock("../db/index.ts", () => ({ createDatabaseFromEnv: () => ({ $client: { end } }) }));
    vi.doMock("../db/clickhouse.ts", () => ({
      createClickHouseClientFromEnv: () => ({ insert: vi.fn(), close }),
    }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv: () => ({
        consumer: {
          observeGroupLifecycle: vi.fn(),
          stop: vi.fn(async () => undefined),
          disconnect: vi.fn(async () => undefined),
        },
        quarantine: { disconnect: vi.fn(async () => undefined) },
        topic: "metric-stream-v1",
      }),
      runMetricStreamEventConsumer: vi.fn(async () => {
        throw failure;
      }),
    }));
    const { runMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink-runtime.ts");
    await expect(
      runMetricStreamClickHouseSinkFromEnv(new MetricStreamConsumerReadiness()),
    ).rejects.toBe(failure);
    expect(end).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("retains a shutdown signal received while consumer startup is pending", async () => {
    let finishStartup!: () => void;
    const startup = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    const stop = vi.fn(async () => undefined);
    const disconnect = vi.fn(async () => undefined);
    const quarantineDisconnect = vi.fn(async () => undefined);
    let startupOptions: RunMetricStreamEventConsumerOptions | undefined;
    const consumer = { observeGroupLifecycle: vi.fn(), stop, disconnect };
    vi.doMock("../db/clickhouse.ts", () => ({
      createClickHouseClientFromEnv: () => ({
        insert: vi.fn(),
        close: vi.fn(async () => undefined),
      }),
    }));
    vi.doMock("../db/index.ts", () => ({
      createDatabaseFromEnv: () => ({ $client: { end: vi.fn(async () => undefined) } }),
    }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv: () => ({
        consumer,
        quarantine: { disconnect: quarantineDisconnect },
        topic: "metric-stream-v1",
      }),
      runMetricStreamEventConsumer: vi.fn((options: RunMetricStreamEventConsumerOptions) => {
        startupOptions = options;
        return startup;
      }),
    }));
    const { runMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink-runtime.ts");
    const readiness = new MetricStreamConsumerReadiness();
    const running = runMetricStreamClickHouseSinkFromEnv(readiness);

    process.emit("SIGTERM");
    expect(readiness.getStatus()).toBe("unavailable");
    expect(stop).not.toHaveBeenCalled();
    startupOptions?.lifecycleListener?.markGroupJoined();
    expect(readiness.getStatus()).toBe("unavailable");
    finishStartup();
    await running;

    expect(stop).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(quarantineDisconnect).toHaveBeenCalledOnce();
  });

  it("keeps publication dependencies open when KafkaJS cannot confirm a drain", async () => {
    const stopFailure = new Error("Kafka consumer stop failed");
    const disconnect = vi.fn(async () => undefined);
    const quarantineDisconnect = vi.fn(async () => undefined);
    const end = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    vi.doMock("../db/clickhouse.ts", () => ({
      createClickHouseClientFromEnv: () => ({ insert: vi.fn(), close }),
    }));
    vi.doMock("../db/index.ts", () => ({ createDatabaseFromEnv: () => ({ $client: { end } }) }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv: () => ({
        consumer: {
          observeGroupLifecycle: vi.fn(),
          stop: vi.fn(async () => {
            throw stopFailure;
          }),
          disconnect,
        },
        quarantine: { disconnect: quarantineDisconnect },
        topic: "metric-stream-v1",
      }),
      runMetricStreamEventConsumer: vi.fn(async () => undefined),
    }));
    const { runMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink-runtime.ts");
    const running = runMetricStreamClickHouseSinkFromEnv(new MetricStreamConsumerReadiness());
    process.emit("SIGTERM");

    await expect(running).rejects.toBe(stopFailure);
    expect(disconnect).not.toHaveBeenCalled();
    expect(quarantineDisconnect).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(stopFailure, {
      tags: { source: "metric-stream-sink-shutdown" },
    });
  });

  it("requires Kafka group lifecycle events for the readiness check", async () => {
    vi.doMock("../db/clickhouse.ts", () => ({
      createClickHouseClientFromEnv: vi.fn(() => ({
        insert: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      })),
    }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv: vi.fn(() => ({
        consumer: {
          connect: vi.fn(async () => undefined),
          subscribe: vi.fn(async () => undefined),
          run: vi.fn(async () => undefined),
          stop: vi.fn(async () => undefined),
          disconnect: vi.fn(async () => undefined),
        },
        quarantine: {
          connect: vi.fn(async () => undefined),
          write: vi.fn(async () => undefined),
          disconnect: vi.fn(async () => undefined),
        },
        topic: "metric-stream-v1",
      })),
      runMetricStreamEventConsumer: vi.fn(),
    }));

    const { runMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink-runtime.ts");

    await expect(
      runMetricStreamClickHouseSinkFromEnv(new MetricStreamConsumerReadiness()),
    ).rejects.toThrow("ClickHouse metric-stream sink requires Kafka group lifecycle events");
  });

  it("starts the readiness server before starting the ClickHouse sink", async () => {
    const readinessServer = Object.assign(new EventEmitter(), {
      listen: vi.fn(() => readinessServer),
      unref: vi.fn(),
      close: vi.fn((callback: (error?: Error) => void) => callback()),
    });
    Object.defineProperty(readinessServer, "listening", { get: () => true });
    const listen = readinessServer.listen;
    const unref = vi.fn();
    readinessServer.unref = unref;
    const createMetricStreamConsumerReadinessServer = vi.fn(() => readinessServer);
    const runMetricStreamEventConsumer = vi.fn(async () => undefined);
    const consumer = {
      connect: vi.fn(async () => undefined),
      observeGroupLifecycle: vi.fn(),
      subscribe: vi.fn(async () => undefined),
      run: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
    };

    vi.doMock("../db/clickhouse.ts", () => ({
      createClickHouseClientFromEnv: vi.fn(() => ({
        insert: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      })),
    }));
    vi.doMock("./consumer-readiness.ts", () => ({
      MetricStreamConsumerReadiness: class MetricStreamConsumerReadiness {
        markUnavailable() {}
      },
      createMetricStreamConsumerReadinessServer,
    }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv: vi.fn(() => ({
        consumer,
        quarantine: {
          connect: vi.fn(async () => undefined),
          write: vi.fn(async () => undefined),
          disconnect: vi.fn(async () => undefined),
        },
        topic: "metric-stream-v1",
      })),
      runMetricStreamEventConsumer,
    }));

    const { startMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink-runtime.ts");

    const starting = startMetricStreamClickHouseSinkFromEnv();
    await Promise.resolve();

    expect(runMetricStreamEventConsumer).not.toHaveBeenCalled();
    readinessServer.emit("listening");
    await vi.waitFor(() => expect(runMetricStreamEventConsumer).toHaveBeenCalledOnce());

    expect(listen).toHaveBeenCalledWith(3001, "0.0.0.0");
    expect(unref).toHaveBeenCalledOnce();
    expect(listen.mock.invocationCallOrder[0]).toBeLessThan(
      runMetricStreamEventConsumer.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(runMetricStreamEventConsumer).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycleListener: expect.any(Object) }),
    );
    process.emit("SIGTERM");
    await starting;
    expect(readinessServer.close).toHaveBeenCalledOnce();
  });

  it("preserves a sink failure and reports readiness server close failure", async () => {
    const sinkFailure = new Error("sink startup failed");
    const closeFailure = new Error("readiness close failed");
    const readinessServer = Object.assign(new EventEmitter(), {
      listen: vi.fn(() => readinessServer),
      unref: vi.fn(),
      close: vi.fn((callback: (error?: Error) => void) => callback(closeFailure)),
    });
    Object.defineProperty(readinessServer, "listening", { get: () => true });
    vi.doMock("./consumer-readiness.ts", () => ({
      MetricStreamConsumerReadiness: class MetricStreamConsumerReadiness {
        markUnavailable() {}
      },
      createMetricStreamConsumerReadinessServer: () => readinessServer,
    }));
    vi.doMock("../db/clickhouse.ts", () => ({
      createClickHouseClientFromEnv: () => ({
        insert: vi.fn(),
        close: vi.fn(async () => undefined),
      }),
    }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv: () => ({
        consumer: {
          observeGroupLifecycle: vi.fn(),
          stop: vi.fn(async () => undefined),
          disconnect: vi.fn(async () => undefined),
        },
        quarantine: { disconnect: vi.fn(async () => undefined) },
        topic: "metric-stream-v1",
      }),
      runMetricStreamEventConsumer: vi.fn(async () => {
        throw sinkFailure;
      }),
    }));
    const { startMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink-runtime.ts");
    const starting = startMetricStreamClickHouseSinkFromEnv();
    readinessServer.emit("listening");

    await expect(starting).rejects.toBe(sinkFailure);
    expect(captureException).toHaveBeenCalledWith(closeFailure, {
      tags: { source: "metric-stream-readiness-close" },
    });
  });

  it("surfaces and reports readiness server close failure after a clean sink shutdown", async () => {
    const closeFailure = new Error("readiness close failed");
    const readinessServer = Object.assign(new EventEmitter(), {
      listen: vi.fn(() => readinessServer),
      unref: vi.fn(),
      close: vi.fn((callback: (error?: Error) => void) => callback(closeFailure)),
    });
    Object.defineProperty(readinessServer, "listening", { get: () => true });
    vi.doMock("./consumer-readiness.ts", () => ({
      MetricStreamConsumerReadiness: class MetricStreamConsumerReadiness {
        markUnavailable() {}
      },
      createMetricStreamConsumerReadinessServer: () => readinessServer,
    }));
    vi.doMock("../db/clickhouse.ts", () => ({
      createClickHouseClientFromEnv: () => ({
        insert: vi.fn(),
        close: vi.fn(async () => undefined),
      }),
    }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv: () => ({
        consumer: {
          observeGroupLifecycle: vi.fn(),
          stop: vi.fn(async () => undefined),
          disconnect: vi.fn(async () => undefined),
        },
        quarantine: { disconnect: vi.fn(async () => undefined) },
        topic: "metric-stream-v1",
      }),
      runMetricStreamEventConsumer: vi.fn(async () => undefined),
    }));
    const { startMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink-runtime.ts");
    const starting = startMetricStreamClickHouseSinkFromEnv();
    readinessServer.emit("listening");
    await vi.waitFor(() => expect(process.listenerCount("SIGTERM")).toBeGreaterThan(0));
    process.emit("SIGTERM");

    await expect(starting).rejects.toBe(closeFailure);
    expect(captureException).toHaveBeenCalledWith(closeFailure, {
      tags: { source: "metric-stream-readiness-close" },
    });
  });

  it("fails before consuming when the readiness server cannot bind", async () => {
    const readinessServer = Object.assign(new EventEmitter(), {
      listen: vi.fn(() => readinessServer),
      unref: vi.fn(),
    });
    const runMetricStreamEventConsumer = vi.fn(async () => undefined);

    vi.doMock("../db/clickhouse.ts", () => ({
      createClickHouseClientFromEnv: vi.fn(() => ({ insert: vi.fn(async () => undefined) })),
    }));
    vi.doMock("./consumer-readiness.ts", () => ({
      MetricStreamConsumerReadiness: class MetricStreamConsumerReadiness {},
      createMetricStreamConsumerReadinessServer: vi.fn(() => readinessServer),
    }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv: vi.fn(() => ({
        consumer: {
          connect: vi.fn(async () => undefined),
          observeGroupLifecycle: vi.fn(),
          subscribe: vi.fn(async () => undefined),
          run: vi.fn(async () => undefined),
        },
        quarantine: {
          connect: vi.fn(async () => undefined),
          write: vi.fn(async () => undefined),
        },
        topic: "metric-stream-v1",
      })),
      runMetricStreamEventConsumer,
    }));

    const { startMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink-runtime.ts");
    const starting = startMetricStreamClickHouseSinkFromEnv();
    const error = new Error("listen EADDRINUSE: address already in use 0.0.0.0:3001");
    readinessServer.emit("error", error);

    await expect(starting).rejects.toThrow(error.message);
    expect(runMetricStreamEventConsumer).not.toHaveBeenCalled();
  });
});
