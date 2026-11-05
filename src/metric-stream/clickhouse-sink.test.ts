import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { coordinateAnalyticsDeliveryGroup } from "../analytics/analytics-delivery.ts";
import type { AnalyticsQueryOwner } from "../analytics/analytics-query-owner.ts";
import { analyticsPosition } from "../analytics/test-helpers.ts";
import { createDatabase } from "../db/index.ts";
import { mapMetricStreamEventToClickHouseRow } from "./clickhouse-row.ts";
import {
  applyMetricStreamEventsToClickHouse,
  runMetricStreamClickHouseSinkFromEnv,
  startMetricStreamClickHouseSinkFromEnv,
} from "./clickhouse-sink.ts";
import type { MetricStreamConsumerBatchContext } from "./consumer-context.ts";
import { MetricStreamConsumerReadiness } from "./consumer-readiness.ts";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamDeletedEvent,
  type MetricStreamDeleteScopeInput,
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
  const query = owner.client.query;
  owner.client.query = async (request) => {
    if (request.query.includes("AS incoming_nanos")) {
      expect(request.use_multipart_params).toBe(true);
      const rows = request.query_params?.keys;
      if (!Array.isArray(rows)) throw new Error("Guard fixture requires bounded rows");
      return {
        json: async () =>
          JSON.parse(
            JSON.stringify(
              rows.map((_row, index) => ({
                row_index: index,
                key_count: "1",
                present: 0,
                incoming_nanos: "1",
              })),
            ),
          ),
      };
    }
    return query(request);
  };
  owner.client.insert = mocks.insert;
  mocks.clickhouse.mockReturnValue({ ...owner.client, close: mocks.chClose });
  return fixture;
}
function currentReadRow(overrides: object = {}, event = sourceEvent) {
  const row = mapMetricStreamEventToClickHouseRow(event, sourceIngestedAt);
  return {
    row_index: 0,
    key_count: "1",
    present: 1,
    incoming_nanos: "1",
    ingested_nanos: "1",
    version: String(row.version),
    has_conflict: 0,
    payload: [
      row.provider_id,
      String(row.generation),
      row.external_id,
      row.device_id,
      row.source_type,
      row.scalar === null ? null : String(Math.fround(row.scalar)),
      row.vector.map((value) => String(Math.fround(value))),
      row.point ?? "",
      row.metadata,
      row.is_deleted,
    ],
    ...overrides,
  };
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
      await input.publish(owner, input.positions, times, new Set());
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
  it("sends a single row through the canonical grouped owner and durable raw timestamp", async () => {
    prepareFixture([[], [], []]);
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
  it("skips committed account fences before raw insertion and validates only eligible rows", async () => {
    const erased = {
      ...sourceEvent,
      id: "00000000-0000-4000-8000-000000000099",
      userId: "00000000-0000-4000-8000-000000000098",
    };
    prepareFixture([
      [{ user_hash: createHash("sha256").update(erased.userId).digest("hex") }],
      [],
      [],
    ]);
    const events = [erased, sourceEvent];
    await expect(
      applyMetricStreamEventsToClickHouse(owner.client, events, batchContext(events), database),
    ).resolves.toBe(1);
    expect(fixture.rows).toHaveLength(1);
    expect(fixture.rows[0]).toMatchObject({
      id: sourceEvent.id,
      ingested_at: "2026-11-03T01:00:00.123457Z",
    });
  });
  it("propagates a raw summary shortfall before a later completion marker", async () => {
    prepareFixture([[]]);
    const original = owner.client.exec;
    owner.client.exec = async (request) => ({ ...(await original(request)), summary: undefined });
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
    ).rejects.toThrow(/written_rows missing/);
    expect(mocks.group).toHaveBeenCalledOnce();
    expect(fixture.commands).toHaveLength(0);
  });
  it("retains a generation tombstone for a stale row using the reserved timestamp", async () => {
    prepareFixture([
      [],
      [],
      [
        {
          user_id: sourceEvent.userId,
          provider_id: sourceEvent.providerId,
          generation: sourceEvent.generation + 1,
        },
      ],
    ]);
    await expect(
      applyMetricStreamEventsToClickHouse(
        owner.client,
        [sourceEvent],
        batchContext([sourceEvent]),
        database,
      ),
    ).resolves.toBe(0);
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.commands[0]?.query_params).toMatchObject({
      row_ids: [sourceEvent.id],
      ingested_ats: [sourceIngestedAt],
    });
  });
  it("skips older current-key replay without writing raw rows or applying its generation correction", async () => {
    prepareFixture([]);
    owner.client.query = async ({ query }) => ({
      json: async () =>
        JSON.parse(
          query.includes("AS incoming_nanos")
            ? JSON.stringify([currentReadRow({ ingested_nanos: "2" })])
            : "[]",
        ),
    });
    await expect(
      applyMetricStreamEventsToClickHouse(
        owner.client,
        [sourceEvent],
        batchContext([sourceEvent]),
        database,
      ),
    ).resolves.toBe(0);
    expect(fixture.rows).toHaveLength(0);
    expect(fixture.commands).toHaveLength(0);
  });
  it("fails a conflicting equal-time payload before raw publication", async () => {
    prepareFixture([]);
    owner.client.query = async ({ query }) => ({
      json: async () =>
        JSON.parse(
          query.includes("AS incoming_nanos")
            ? JSON.stringify([currentReadRow({ has_conflict: 1 })])
            : "[]",
        ),
    });
    await expect(
      applyMetricStreamEventsToClickHouse(
        owner.client,
        [sourceEvent],
        batchContext([sourceEvent]),
        database,
      ),
    ).rejects.toThrow(/conflicting.*payload/i);
    expect(fixture.rows).toHaveLength(0);
  });
  it("skips an identical canonical Float32 and nullable payload at the same rank", async () => {
    prepareFixture([]);
    owner.client.query = async ({ query }) => ({
      json: async () =>
        JSON.parse(query.includes("AS incoming_nanos") ? JSON.stringify([currentReadRow()]) : "[]"),
    });
    await expect(
      applyMetricStreamEventsToClickHouse(
        owner.client,
        [sourceEvent],
        batchContext([sourceEvent]),
        database,
      ),
    ).resolves.toBe(0);
    expect(fixture.rows).toHaveLength(0);
    expect(fixture.commands).toHaveLength(0);
  });
  it.each(["scalar", "vector"])(
    "skips identical replay of a serialized signed zero in %s",
    async (field) => {
      prepareFixture([]);
      const event = {
        ...sourceEvent,
        ...(field === "scalar" ? { scalar: -0 } : { vector: [-0, 1] }),
      };
      owner.client.query = async ({ query }) => ({
        json: async () =>
          JSON.parse(
            query.includes("AS incoming_nanos")
              ? JSON.stringify([currentReadRow({}, event)])
              : "[]",
          ),
      });
      await expect(
        applyMetricStreamEventsToClickHouse(owner.client, [event], batchContext([event]), database),
      ).resolves.toBe(0);
      expect(fixture.rows).toHaveLength(0);
      expect(fixture.commands).toHaveLength(0);
    },
  );
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
    expect(mocks.group).toHaveBeenCalledOnce();
  });
  it("writes a native completion coordinate after ordered raw publication", async () => {
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
    expect(trace).toEqual(["group"]);
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
    expect(fixture.commands[0]?.query).toContain(`"operation_revision":"${operationRevision}"`);
    expect(fixture.commands[1]?.query_params).toMatchObject({
      ingested_at: sourceIngestedAt,
      replacement_version: "2000000000000000",
    });
    expect(fixture.commands.at(-1)?.query_params).toEqual({
      event_id: event.eventId,
      ingested_at: sourceIngestedAt,
    });
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
    prepareFixture([[], [], []]);
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
