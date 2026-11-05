import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  coordinateAnalyticsDelivery,
  coordinateAnalyticsDeliveryGroup,
} from "../analytics/analytics-delivery.ts";
import type { AnalyticsQueryOwner } from "../analytics/analytics-query-owner.ts";
import { analyticsPosition } from "../analytics/test-helpers.ts";
import { createDatabase } from "../db/index.ts";
import {
  applyMetricStreamEventsToClickHouse,
  markMetricStreamScopeDeletedInClickHouse,
  markMetricStreamScopesDeletedInClickHouse,
  runMetricStreamClickHouseSinkFromEnv,
  startMetricStreamClickHouseSinkFromEnv,
} from "./clickhouse-sink.ts";
import { METRIC_STREAM_TABLE } from "./clickhouse-table.ts";
import type { MetricStreamConsumerBatchContext } from "./consumer-context.ts";
import { MetricStreamConsumerReadiness } from "./consumer-readiness.ts";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamDeletedEvent,
  type MetricStreamDeleteScopeInput,
  type MetricStreamEventV1,
  type MetricStreamRedpandaEvent,
} from "./events.ts";
import type { runPulsarMetricStreamConsumer } from "./pulsar-consumer.ts";
import { sourceEvent, sourceIngestedAt, sourceOwner, sourcePosition } from "./test-helpers.ts";

const mocks = vi.hoisted(() => ({
  group: vi.fn(),
  control: vi.fn(),
  load: vi.fn(),
  run: vi.fn(),
  client: vi.fn(),
  database: vi.fn(),
  clickhouse: vi.fn(),
  nativeClose: vi.fn(),
  chClose: vi.fn(),
  dbClose: vi.fn(),
  insert: vi.fn(),
  capture: vi.fn(),
  server: vi.fn(),
}));
vi.mock("../analytics/analytics-delivery.ts", () => ({
  coordinateAnalyticsDeliveryGroup: mocks.group,
  coordinateAnalyticsDelivery: mocks.control,
}));
vi.mock("../analytics/analytics-work-store.ts", () => ({ loadAnalyticsStreamState: mocks.load }));
vi.mock("./pulsar-consumer.ts", () => ({ runPulsarMetricStreamConsumer: mocks.run }));
vi.mock("./consumer-readiness.ts", async (original) => ({
  ...(await original<typeof import("./consumer-readiness.ts")>()),
  createMetricStreamConsumerReadinessServer: mocks.server,
}));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: mocks.capture }));
vi.mock("../db/clickhouse.ts", async (original) => ({
  ...(await original<typeof import("../db/clickhouse.ts")>()),
  createClickHouseClientFromEnv: mocks.clickhouse,
}));
vi.mock("../db/index.ts", async (original) => ({
  ...(await original<typeof import("../db/index.ts")>()),
  createDatabaseFromEnv: mocks.database,
}));
vi.mock("pulsar-client", async (original) => {
  const actual = await original<
    typeof import("pulsar-client") & { default: typeof import("pulsar-client") }
  >();
  return { ...actual, default: { ...actual.default, Client: mocks.client } };
});
const database = createDatabase("postgres://unit:unit@localhost/unit");
const closeDatabase = database.$client.end.bind(database.$client);
afterAll(async () => closeDatabase());
let fixture = sourceOwner();
let owner: AnalyticsQueryOwner = fixture.owner;
let trace: string[] = [];
let signals = new EventEmitter();
const processOnce = process.once.bind(process);
const processOff = process.off.bind(process);
const native = { subscribe: vi.fn(), close: mocks.nativeClose };
const operationRevision = "1000000000000000";
function createCurrentMetricStreamDeletedEvent(scope: MetricStreamDeleteScopeInput) {
  return createMetricStreamDeletedEvent(scope, operationRevision);
}
function batchContext(
  events: readonly MetricStreamRedpandaEvent[],
): MetricStreamConsumerBatchContext {
  return {
    topic: sourcePosition.topic,
    partition: -1,
    positions: events.map((_event, index) => analyticsPosition(sourcePosition, BigInt(index + 1))),
    assertActive: vi.fn().mockResolvedValue(undefined),
  };
}
function prepareFixture(rows: readonly (readonly object[])[]) {
  fixture = sourceOwner(rows);
  owner = fixture.owner;
  owner.client.insert = mocks.insert;
  mocks.clickhouse.mockReturnValue({ ...owner.client, close: mocks.chClose });
  return fixture;
}
beforeEach(() => {
  vi.resetAllMocks();
  trace = [];
  signals = new EventEmitter();
  vi.stubEnv("PULSAR_SERVICE_URL", "pulsar://fixture:6650");
  vi.stubEnv("METRIC_STREAM_TOPIC", sourcePosition.topic);
  vi.stubEnv("METRIC_STREAM_TRANSPORT_EPOCH", sourcePosition.epoch);
  vi.stubEnv("METRIC_STREAM_SUBSCRIPTION", "sink-fixture");
  database.$client.end = mocks.dbClose;
  mocks.dbClose.mockResolvedValue(undefined);
  mocks.nativeClose.mockResolvedValue(null);
  mocks.chClose.mockResolvedValue(undefined);
  mocks.insert.mockResolvedValue(undefined);
  mocks.database.mockReturnValue(database);
  mocks.load.mockResolvedValue(null);
  mocks.run.mockResolvedValue(undefined);
  mocks.client.mockImplementation(function NativeClientFixture() {
    return native;
  });
  prepareFixture([]);
  mocks.group.mockImplementation(
    async (_journal, input: Parameters<typeof coordinateAnalyticsDeliveryGroup>[1]) => {
      trace.push("group");
      const times = input.positions.map((_position, index) =>
        index ? "2026-11-03T01:00:00.123457Z" : sourceIngestedAt,
      );
      const effects = await input.prepare(owner, input.positions, times);
      await input.apply(owner, input.positions, effects, times);
    },
  );
  mocks.control.mockImplementation(
    async (_journal, input: Parameters<typeof coordinateAnalyticsDelivery>[1]) => {
      trace.push("control");
      const pages = [];
      for await (const page of input.prepare(owner)) pages.push(page);
      await input.applyControl(owner);
      for (const page of pages) await input.apply(owner, page);
      trace.push("receipt");
      await input.acknowledgeEffects(owner);
    },
  );
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    if (event === "SIGTERM" || event === "SIGINT") {
      signals.once(event, listener);
      return process;
    }
    return processOnce(event, listener);
  });
  vi.spyOn(process, "off").mockImplementation((event, listener) => {
    if (event === "SIGTERM" || event === "SIGINT") {
      signals.off(event, listener);
      return process;
    }
    return processOff(event, listener);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("native grouped ClickHouse applier", () => {
  it("sends a single row through the canonical grouped owner and frozen source preparation", async () => {
    prepareFixture([
      [],
      [],
      [{ source_id: sourceEvent.id, generation: "1", recorded_at: sourceEvent.recordedAt }],
      [],
    ]);
    const context = batchContext([sourceEvent]);
    expect(
      await applyMetricStreamEventsToClickHouse(owner.client, [sourceEvent], context, database),
    ).toBe(1);
    expect(mocks.group).toHaveBeenCalledWith(
      { database, clickhouse: owner.client },
      expect.objectContaining({ positions: context.positions, maximum: 500 }),
    );
    expect(fixture.rows[0]).toMatchObject({
      id: sourceEvent.id,
      ingested_at: sourceIngestedAt,
      version: "9007199254740993",
    });
  });
  it("rejects missing position membership before dispatch", async () => {
    const context = { ...batchContext([sourceEvent]), positions: [] };
    await expect(
      applyMetricStreamEventsToClickHouse(owner.client, [sourceEvent], context, database),
    ).rejects.toThrow(/positions.*align/i);
    expect(mocks.group).not.toHaveBeenCalled();
  });
  it("stops before a later marker when the grouped row fails", async () => {
    mocks.group.mockRejectedValue(new Error("journal failed"));
    const marker = createMetricStreamBatchCompletedEvent(
      {
        operationId: "00000000-0000-4000-8000-000000000003",
        batchId: "batch",
        datasetKeys: ["metric_stream"],
      },
      1,
    );
    const events = [sourceEvent, marker];
    await expect(
      applyMetricStreamEventsToClickHouse(owner.client, events, batchContext(events), database),
    ).rejects.toThrow("journal failed");
    expect(mocks.control).not.toHaveBeenCalled();
  });
  it("writes a native completion coordinate only after control receipt proof", async () => {
    prepareFixture([[]]);
    const marker = createMetricStreamBatchCompletedEvent(
      {
        operationId: "00000000-0000-4000-8000-000000000003",
        batchId: "batch",
        datasetKeys: ["metric_stream"],
      },
      1,
    );
    const context = batchContext([marker]);
    expect(
      await applyMetricStreamEventsToClickHouse(owner.client, [marker], context, database),
    ).toBe(0);
    expect(trace).toEqual(["control", "receipt"]);
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.commands[0]?.query_params).toMatchObject({
      operation_id: marker.operationId,
      batch_id: "batch",
      expected_event_count: 1,
      topic: context.topic,
      partition: -1,
      marker_offset: null,
      marker_transport: "pulsar",
      marker_epoch: sourcePosition.epoch,
      marker_message_id:
        context.positions[0]?.transport === "pulsar"
          ? context.positions[0].serializedMessageId
          : "invalid fixture",
    });
  });
  it("preserves the operation erasure fence before native completion", async () => {
    const marker = createMetricStreamBatchCompletedEvent(
      {
        operationId: "00000000-0000-4000-8000-000000000003",
        batchId: "batch",
        datasetKeys: ["metric_stream"],
      },
      1,
    );
    prepareFixture([
      [{ operation_hash: createHash("sha256").update(marker.operationId).digest("hex") }],
    ]);
    await applyMetricStreamEventsToClickHouse(
      owner.client,
      [marker],
      batchContext([marker]),
      database,
    );
    expect(fixture.commands).toEqual([]);
  });
  it("persists a replacement scope and acknowledgement through the streaming control owner", async () => {
    prepareFixture([[], []]);
    const event = createCurrentMetricStreamDeletedEvent({ userId: sourceEvent.userId });
    await applyMetricStreamEventsToClickHouse(
      owner.client,
      [event],
      batchContext([event]),
      database,
    );
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        values: [
          expect.objectContaining({
            user_id: sourceEvent.userId,
            operation_revision: operationRevision,
          }),
        ],
      }),
    );
    expect(fixture.commands[0]?.query_params).toEqual({ eventId: event.eventId });
  });
});

describe("native sink runner", () => {
  it("closes its readiness server after native intake and owned resources settle", async () => {
    const server = Object.assign(new EventEmitter(), {
      listening: false,
      listen: vi.fn(() => {
        queueMicrotask(() => {
          server.listening = true;
          server.emit("listening");
        });
        return server;
      }),
      unref: vi.fn(),
      close: vi.fn((callback: (error?: Error) => void) => {
        server.listening = false;
        callback();
        return server;
      }),
    });
    mocks.server.mockReturnValue(server);
    await startMetricStreamClickHouseSinkFromEnv();
    expect(server.unref).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(mocks.nativeClose).toHaveBeenCalledOnce();
  });
  it("fails binding readiness before constructing any intake resources", async () => {
    const server = Object.assign(new EventEmitter(), {
      listening: false,
      listen: vi.fn(() => {
        queueMicrotask(() => server.emit("error", new Error("bind failed")));
        return server;
      }),
      unref: vi.fn(),
      close: vi.fn(),
    });
    mocks.server.mockReturnValue(server);
    await expect(startMetricStreamClickHouseSinkFromEnv()).rejects.toThrow("bind failed");
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.database).not.toHaveBeenCalled();
    expect(server.close).not.toHaveBeenCalled();
  });
  it.each([
    "PULSAR_SERVICE_URL",
    "METRIC_STREAM_TOPIC",
    "METRIC_STREAM_TRANSPORT_EPOCH",
    "METRIC_STREAM_SUBSCRIPTION",
  ])("fails before resource creation for missing %s", async (key) => {
    vi.stubEnv(key, "");
    const readiness = new MetricStreamConsumerReadiness();
    await expect(runMetricStreamClickHouseSinkFromEnv(readiness)).rejects.toThrow(key);
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.database).not.toHaveBeenCalled();
    expect(readiness.getStatus()).toBe("unavailable");
  });
  it("wires the concrete stream, exact pending group loader and canonical handler", async () => {
    prepareFixture([
      [],
      [],
      [{ source_id: sourceEvent.id, generation: "1", recorded_at: sourceEvent.recordedAt }],
      [],
    ]);
    const pending = { memberCount: 1 };
    mocks.load.mockResolvedValue({ pendingGroup: pending });
    const readiness = new MetricStreamConsumerReadiness();
    mocks.run.mockImplementation(
      async (options: Parameters<typeof runPulsarMetricStreamConsumer>[0]) => {
        expect(options).toMatchObject({
          topic: sourcePosition.topic,
          partition: -1,
          epoch: sourcePosition.epoch,
          subscription: "sink-fixture",
          receiverQueueSize: 20,
          nativeBatchMessages: 20,
          nativeBatchBytes: 8388608,
          maxGroupMessages: 500,
          maxGroupBytes: 8388608,
          readiness,
        });
        expect(await options.loadPendingGroup()).toBe(pending);
        expect(mocks.load).toHaveBeenCalledWith(database, {
          transport: "pulsar",
          epoch: sourcePosition.epoch,
          topic: sourcePosition.topic,
          partition: -1,
        });
        await options.handleEvents([sourceEvent], {
          ...batchContext([sourceEvent]),
          deliveries: [],
        });
      },
    );
    await runMetricStreamClickHouseSinkFromEnv(readiness);
    expect(mocks.nativeClose).toHaveBeenCalledOnce();
    expect(mocks.chClose).toHaveBeenCalledOnce();
    expect(mocks.dbClose).toHaveBeenCalledOnce();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });
  it("marks unavailable and stops intake on a real signal before resource cleanup", async () => {
    const readiness = new MetricStreamConsumerReadiness();
    mocks.run.mockImplementation(
      async (options: Parameters<typeof runPulsarMetricStreamConsumer>[0]) => {
        readiness.markReady(() => true);
        signals.emit("SIGTERM");
        expect(options.signal.aborted).toBe(true);
        expect(readiness.getStatus()).toBe("unavailable");
      },
    );
    await runMetricStreamClickHouseSinkFromEnv(readiness);
    expect(mocks.nativeClose).toHaveBeenCalledOnce();
    expect(mocks.dbClose).toHaveBeenCalledOnce();
  });
  it("settles every acquired close after intake failure and retains cleanup failure", async () => {
    mocks.run.mockRejectedValue(new Error("intake failed"));
    mocks.nativeClose.mockRejectedValue(new Error("native close failed"));
    const readiness = new MetricStreamConsumerReadiness();
    await expect(runMetricStreamClickHouseSinkFromEnv(readiness)).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "intake failed" }),
        expect.objectContaining({ message: "native close failed" }),
      ],
    });
    expect(mocks.chClose).toHaveBeenCalledOnce();
    expect(mocks.dbClose).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalled();
    expect(readiness.getStatus()).toBe("unavailable");
  });
  it("closes earlier acquisitions when native client construction fails", async () => {
    mocks.client.mockImplementation(function FailingNativeClientFixture() {
      throw new Error("native initialization failed");
    });
    await expect(
      runMetricStreamClickHouseSinkFromEnv(new MetricStreamConsumerReadiness()),
    ).rejects.toThrow("native initialization failed");
    expect(mocks.chClose).toHaveBeenCalledOnce();
    expect(mocks.dbClose).toHaveBeenCalledOnce();
    expect(mocks.nativeClose).not.toHaveBeenCalled();
  });
});

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

function firstCommandQuery(command: CallableVitestMock): string {
  const call = command.mock.calls
    .map((args: unknown[]) => args[0])
    .find(
      (arg: unknown) =>
        typeof arg === "object" &&
        arg !== null &&
        "query" in arg &&
        typeof arg.query === "string" &&
        arg.query.startsWith(`INSERT INTO ${METRIC_STREAM_TABLE} (`),
    );
  if (!call || typeof call !== "object" || !("query" in call) || typeof call.query !== "string") {
    throw new Error("expected command call");
  }
  return call.query;
}

describe("legacy eraser scope API", () => {
  it("batches compatible delete scopes into one stream-table scan", async () => {
    const command = vi.fn(async () => undefined);
    const firstDelete = createCurrentMetricStreamDeletedEvent({
      userId: heartRateEvent.userId,
      providerId: heartRateEvent.providerId,
      externalId: "hk:heart-rate-1",
    });
    const secondDelete = createCurrentMetricStreamDeletedEvent({
      userId: heartRateEvent.userId,
      providerId: heartRateEvent.providerId,
      externalId: "hk:heart-rate-2",
    });

    await markMetricStreamScopesDeletedInClickHouse({ command }, [firstDelete, secondDelete]);

    expect(command).toHaveBeenCalledTimes(4);
    expect(firstCommandQuery(command)).toContain(
      "candidate_row.external_id = {external_id_0:String}",
    );
    expect(firstCommandQuery(command)).toContain("scope_index = 0 AND latest_row.2");
    expect(firstCommandQuery(command)).toContain("latest_row.6 = {external_id_0:String}");
    expect(firstCommandQuery(command)).toContain(
      "candidate_row.external_id = {external_id_1:String}",
    );
    expect(command).toHaveBeenNthCalledWith(2, {
      query: expect.stringContaining(`INSERT INTO ${METRIC_STREAM_TABLE}`),
      query_params: {
        external_id_0: "hk:heart-rate-1",
        external_id_1: "hk:heart-rate-2",
        provider_id_0: heartRateEvent.providerId,
        provider_id_1: heartRateEvent.providerId,
        replacement_version: "2000000000000000",
        user_id_0: heartRateEvent.userId,
        user_id_1: heartRateEvent.userId,
      },
    });
  });
  it("rejects replacement delete scopes that produce no ClickHouse conditions", async () => {
    await expect(
      markMetricStreamScopeDeletedInClickHouse(
        { command: vi.fn(async () => undefined), insert: vi.fn(async () => undefined) },
        {},
      ),
    ).rejects.toThrow("Metric stream delete scope produced no ClickHouse conditions");
  });
});
