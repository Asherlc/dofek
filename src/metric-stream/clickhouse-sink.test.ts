import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { coordinateAnalyticsDelivery } from "../analytics/analytics-delivery.ts";
import * as clickhouse from "../db/clickhouse.ts";
import type { Database } from "../db/index.ts";
import {
  applyMetricStreamEventsToClickHouse,
  runMetricStreamClickHouseSinkFromEnv,
  startMetricStreamClickHouseSinkFromEnv,
} from "./clickhouse-sink.ts";
import * as consumerReadiness from "./consumer-readiness.ts";
import { MetricStreamConsumerReadiness } from "./consumer-readiness.ts";
import type { MetricStreamEventV1 } from "./events.ts";
import type { RunMetricStreamEventConsumerOptions } from "./redpanda-consumer.ts";
import { kafkaTestPositions } from "./test-helpers.ts";

const runtime = vi.hoisted(() => ({
  database: Object.create(null),
  coordinate: vi.fn<typeof coordinateAnalyticsDelivery>(async () => undefined),
  runConsumer: vi.fn<(options: RunMetricStreamEventConsumerOptions) => Promise<void>>(
    async () => undefined,
  ),
  captureException: vi.fn(),
  lifecycle: vi.fn(),
}));
const client = {
  command: vi.fn(async () => undefined),
  query: vi.fn(async () => ({ json: async () => [] })),
  insert: vi.fn(async () => undefined),
};
vi.mock("../analytics/analytics-delivery.ts", () => ({
  coordinateAnalyticsDelivery: runtime.coordinate,
}));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: runtime.captureException }));
vi.mock("../db/index.ts", () => ({ createDatabaseFromEnv: () => runtime.database }));
vi.mock("../db/clickhouse.ts", () => ({ createClickHouseClientFromEnv: () => client }));
vi.mock("./redpanda-consumer.ts", () => ({
  createKafkaMetricStreamConsumerFromEnv: () => ({
    consumer: { observeGroupLifecycle: runtime.lifecycle },
    quarantine: {},
    topic: "metric-stream-v1",
    epoch: "test-epoch",
  }),
  runMetricStreamEventConsumer: runtime.runConsumer,
}));

const row: MetricStreamEventV1 = {
  version: 1,
  id: "10000000-0000-4000-8000-000000000001",
  recordedAt: "2026-06-06T19:00:00.000Z",
  userId: "00000000-0000-4000-8000-000000000001",
  providerId: "test",
  generation: 0,
  sourceType: "api",
  channel: "heart_rate",
  scalar: 72,
};
const database: Database = runtime.database;
function context(offsets = ["42"]) {
  return {
    topic: "metric-stream-v1",
    partition: 2,
    positions: kafkaTestPositions(offsets),
    assertActive: vi.fn(async () => undefined),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  runtime.coordinate.mockImplementation(async () => undefined);
});

describe("applyMetricStreamEventsToClickHouse", () => {
  it("requires delivery coordination before admitting raw mutation", async () => {
    await expect(
      Reflect.apply(applyMetricStreamEventsToClickHouse, undefined, [client, [row]]),
    ).rejects.toThrow("requires typed delivery context and analytics journal");
    expect(client.insert).not.toHaveBeenCalled();
  });
  it.each([
    { name: "missing", positions: [] },
    { name: "different topic", positions: kafkaTestPositions(["42"], "wrong") },
    { name: "different partition", positions: kafkaTestPositions(["42"], "metric-stream-v1", 0) },
  ])("rejects $name delivery positions before raw mutation", async ({ positions }) => {
    await expect(
      applyMetricStreamEventsToClickHouse(client, [row], { ...context(), positions }, database),
    ).rejects.toThrow("delivery positions");
    expect(runtime.coordinate).not.toHaveBeenCalled();
  });
  it("rejects out-of-order native deliveries without inventing contiguous offsets", async () => {
    await expect(
      applyMetricStreamEventsToClickHouse(client, [row, row], context(["42", "41"]), database),
    ).rejects.toThrow("delivery order");
    await applyMetricStreamEventsToClickHouse(
      client,
      [row, row],
      context(["42", "1000"]),
      database,
    );
    expect(runtime.coordinate).toHaveBeenCalledTimes(2);
  });
  it("keeps transport heartbeats active while publication ownership is pending", async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {
      throw new Error("Barrier missing");
    };
    runtime.coordinate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const batch = context();
    const pending = applyMetricStreamEventsToClickHouse(client, [row], batch, database);
    await vi.advanceTimersByTimeAsync(6000);
    expect(batch.assertActive.mock.calls.length).toBeGreaterThan(1);
    finish();
    await expect(pending).resolves.toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stops before the next delivery when active ownership is lost", async () => {
    const batch = context(["42", "43"]);
    runtime.coordinate.mockImplementationOnce(async () => {
      batch.assertActive.mockRejectedValue(new Error("ownership lost"));
    });
    await expect(
      applyMetricStreamEventsToClickHouse(client, [row, row], batch, database),
    ).rejects.toThrow("ownership lost");
    expect(runtime.coordinate).toHaveBeenCalledOnce();
  });
});

describe("Kafka production composition", () => {
  it("rejects missing insert support before consumption starts", async () => {
    vi.spyOn(clickhouse, "createClickHouseClientFromEnv").mockReturnValue({
      command: client.command,
      query: client.query,
    });
    await expect(
      runMetricStreamClickHouseSinkFromEnv(new MetricStreamConsumerReadiness()),
    ).rejects.toThrow("insert-capable client");
    expect(runtime.runConsumer).not.toHaveBeenCalled();
  });
  it("supplies the runtime database and typed context to the canonical coordinator", async () => {
    await runMetricStreamClickHouseSinkFromEnv(new MetricStreamConsumerReadiness());
    const invocation = runtime.runConsumer.mock.calls[0]?.[0];
    if (!invocation) throw new Error("Consumer was not started");
    const batch = context();
    await invocation.handleEvents([row], batch);
    expect(runtime.coordinate).toHaveBeenCalledWith(
      { database, clickhouse: client },
      expect.objectContaining({ position: batch.positions[0], assertActive: batch.assertActive }),
    );
    expect(invocation.epoch).toBe("test-epoch");
  });

  it("starts readiness before consumption and releases the readiness listener after bind", async () => {
    const server = createServer();
    const listen = vi.spyOn(server, "listen").mockReturnValue(server);
    const unref = vi.spyOn(server, "unref").mockReturnValue(server);
    vi.spyOn(consumerReadiness, "createMetricStreamConsumerReadinessServer").mockReturnValue(
      server,
    );
    const pending = startMetricStreamClickHouseSinkFromEnv();
    expect(runtime.runConsumer).not.toHaveBeenCalled();
    server.emit("listening");
    await pending;
    expect(listen).toHaveBeenCalledWith(3001, "0.0.0.0");
    expect(unref).toHaveBeenCalledOnce();
    expect(server.listenerCount("error")).toBe(0);
    expect(runtime.runConsumer).toHaveBeenCalledOnce();
  });

  it("reports readiness bind failure without starting consumption", async () => {
    const server = createServer();
    const baselineListening = server.listenerCount("listening");
    vi.spyOn(server, "listen").mockReturnValue(server);
    vi.spyOn(consumerReadiness, "createMetricStreamConsumerReadinessServer").mockReturnValue(
      server,
    );
    const pending = startMetricStreamClickHouseSinkFromEnv();
    server.emit("error", new Error("readiness EADDRINUSE"));
    await expect(pending).rejects.toThrow("readiness EADDRINUSE");
    expect(runtime.runConsumer).not.toHaveBeenCalled();
    expect(server.listenerCount("listening")).toBe(baselineListening);
  });
});
