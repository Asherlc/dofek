import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMetricStreamEventsToClickHouse,
  insertMetricStreamEventsIntoClickHouse,
  mapMetricStreamEventToClickHouseRow,
  markMetricStreamScopeDeletedInClickHouse,
  markMetricStreamScopesDeletedInClickHouse,
} from "./clickhouse-sink.ts";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_TABLE,
} from "./clickhouse-table.ts";
import { MetricStreamConsumerReadiness } from "./consumer-readiness.ts";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamDeletedEvent,
  type MetricStreamDeletedEventV1,
  type MetricStreamDeleteScopeInput,
  type MetricStreamEventV1,
} from "./events.ts";
import type { RunMetricStreamEventConsumerOptions } from "./redpanda-consumer.ts";

const captureException = vi.hoisted(() => vi.fn());

vi.mock("../lib/error-reporting.ts", () => ({
  captureException,
}));

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

const operationRevision = "1000000000000000";

function createCurrentMetricStreamDeletedEvent(scope: MetricStreamDeleteScopeInput) {
  return createMetricStreamDeletedEvent(scope, operationRevision);
}

function firstCommandQuery(command: CallableVitestMock): string {
  const call = command.mock.calls[0]?.[0];
  if (!call || typeof call !== "object" || !("query" in call) || typeof call.query !== "string") {
    throw new Error("expected command call");
  }
  return call.query;
}

function insertedValues(insert: CallableVitestMock, callIndex: number): unknown[] {
  const call = insert.mock.calls[callIndex]?.[0];
  if (!call || typeof call !== "object" || !("values" in call) || !Array.isArray(call.values)) {
    throw new Error("expected an insert call with row values");
  }
  return call.values;
}

function makeEmptyGenerationQuery() {
  return vi.fn(async () => ({ json: async () => [] }));
}

afterEach(() => {
  vi.useRealTimers();
  captureException.mockClear();
  vi.doUnmock("../db/clickhouse.ts");
  vi.doUnmock("./consumer-readiness.ts");
  vi.doUnmock("./redpanda-consumer.ts");
  vi.resetModules();
});

describe("insertMetricStreamEventsIntoClickHouse", () => {
  it("inserts non-IMU events into the ingest metric stream table", async () => {
    const insert = vi.fn(async () => undefined);

    const inserted = await insertMetricStreamEventsIntoClickHouse({ insert }, [heartRateEvent]);

    expect(inserted).toBe(1);
    expect(insert).toHaveBeenCalledWith({
      table: METRIC_STREAM_TABLE,
      format: "JSONEachRow",
      clickhouse_settings: { date_time_input_format: "best_effort" },
      values: [
        expect.objectContaining({
          id: heartRateEvent.id,
          recorded_at: heartRateEvent.recordedAt,
          channel: "heart_rate",
          external_id: "hk:heart-rate-1",
          device_id: "Apple Watch",
          scalar: 72,
          generation: 0,
          is_deleted: 0,
        }),
      ],
    });
  });

  it("skips IMU events because the analytics mirror intentionally excludes them", async () => {
    const insert = vi.fn(async () => undefined);

    const inserted = await insertMetricStreamEventsIntoClickHouse({ insert }, [imuEvent]);

    expect(inserted).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it("does not insert empty batches", async () => {
    const insert = vi.fn(async () => undefined);

    const inserted = await insertMetricStreamEventsIntoClickHouse({ insert }, []);

    expect(inserted).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it("maps optional nullable fields and vector fields into ClickHouse rows", () => {
    const row = mapMetricStreamEventToClickHouseRow({
      ...heartRateEvent,
      activityId: "20000000-0000-4000-8000-000000000001",
      vector: [1, 2, 3],
      point: '{"type":"Point","coordinates":[-122.4,37.8]}',
      metadata: { source: "test" },
    });

    expect(row.external_id).toBe("hk:heart-rate-1");
    expect(row.device_id).toBe("Apple Watch");
    expect(row.activity_id).toBe("20000000-0000-4000-8000-000000000001");
    expect(row.scalar).toBe(72);
    expect(row.point).toBe('{"type":"Point","coordinates":[-122.4,37.8]}');
    expect(row.generation).toBe(0);
    expect(row.version).toBe(0);
  });

  it("normalizes EWKT point events into the GeoJSON string ClickHouse read models expect", () => {
    const row = mapMetricStreamEventToClickHouseRow({
      ...heartRateEvent,
      point: "SRID=4326;POINT(-122.4 37.8)",
    });

    expect(row.point).toBe('{"type":"Point","coordinates":[-122.4,37.8]}');
  });

  it("maps omitted optional fields into null ClickHouse values", () => {
    const row = mapMetricStreamEventToClickHouseRow({
      version: 1,
      id: "10000000-0000-4000-8000-000000000003",
      recordedAt: "2026-06-06T19:00:00.000Z",
      userId: "00000000-0000-0000-0000-000000000001",
      providerId: "apple_health",
      generation: 0,
      sourceType: "api",
      channel: "heart_rate",
    });

    expect(row.external_id).toBeNull();
    expect(row.device_id).toBeNull();
    expect(row.activity_id).toBeNull();
    expect(row.scalar).toBeNull();
    expect(row.point).toBeNull();
  });
});

describe("applyMetricStreamEventsToClickHouse", () => {
  it("keeps Kafka heartbeats alive while a ClickHouse write is pending", async () => {
    vi.useFakeTimers();
    let resolveInsert: (() => void) | undefined;
    const insertion = new Promise<void>((resolve) => {
      resolveInsert = resolve;
    });
    const insert = vi.fn(() => insertion);
    const heartbeat = vi.fn(async () => undefined);
    const applying = applyMetricStreamEventsToClickHouse(
      { insert, query: makeEmptyGenerationQuery() },
      [heartRateEvent],
      {
        topic: "metric-stream-v1",
        partition: 2,
        eventOffsets: ["42"],
        heartbeat,
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(insert).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(heartbeat).toHaveBeenCalledOnce();

    resolveInsert?.();
    await applying;

    const heartbeatsAfterCompletion = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(heartbeat).toHaveBeenCalledTimes(heartbeatsAfterCompletion);
  });

  it("fails after a keepalive heartbeat fails during a pending ClickHouse write", async () => {
    vi.useFakeTimers();
    let resolveInsert: (() => void) | undefined;
    const insertion = new Promise<void>((resolve) => {
      resolveInsert = resolve;
    });
    const heartbeatFailure = new Error("Kafka heartbeat failed");
    const heartbeat = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(heartbeatFailure)
      .mockResolvedValue(undefined);
    const applying = applyMetricStreamEventsToClickHouse(
      { insert: vi.fn(() => insertion), query: makeEmptyGenerationQuery() },
      [heartRateEvent],
      {
        topic: "metric-stream-v1",
        partition: 2,
        eventOffsets: ["42"],
        heartbeat,
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(heartbeat).toHaveBeenCalledOnce();
    resolveInsert?.();

    await expect(applying).rejects.toThrow(heartbeatFailure.message);
    expect(captureException).toHaveBeenCalledWith(heartbeatFailure, {
      tags: {
        metricStreamConsumer: "clickhouse-sink",
        metricStreamFailure: "heartbeat",
      },
    });
  });

  it("does not overlap keepalive heartbeats while a previous heartbeat is pending", async () => {
    vi.useFakeTimers();
    let resolveInsert: (() => void) | undefined;
    let resolveHeartbeat: (() => void) | undefined;
    const insertion = new Promise<void>((resolve) => {
      resolveInsert = resolve;
    });
    const pendingHeartbeat = new Promise<void>((resolve) => {
      resolveHeartbeat = resolve;
    });
    const heartbeat = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => pendingHeartbeat)
      .mockResolvedValue(undefined);
    const applying = applyMetricStreamEventsToClickHouse(
      { insert: vi.fn(() => insertion), query: makeEmptyGenerationQuery() },
      [heartRateEvent],
      {
        topic: "metric-stream-v1",
        partition: 2,
        eventOffsets: ["42"],
        heartbeat,
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(heartbeat).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(heartbeat).toHaveBeenCalledOnce();

    resolveHeartbeat?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(heartbeat).toHaveBeenCalledTimes(2);

    resolveInsert?.();
    await applying;
  });

  it("applies events without Kafka context", async () => {
    const insert = vi.fn(async () => undefined);

    await expect(
      applyMetricStreamEventsToClickHouse({ insert, query: makeEmptyGenerationQuery() }, [
        heartRateEvent,
      ]),
    ).resolves.toBe(1);
    expect(insert).toHaveBeenCalledOnce();
  });

  it("does not schedule heartbeats when Kafka context is absent", async () => {
    vi.useFakeTimers();
    let resolveInsert: (() => void) | undefined;
    const insertion = new Promise<void>((resolve) => {
      resolveInsert = resolve;
    });
    const applying = applyMetricStreamEventsToClickHouse(
      { insert: vi.fn(() => insertion), query: makeEmptyGenerationQuery() },
      [heartRateEvent],
    );

    await vi.advanceTimersByTimeAsync(3_000);
    resolveInsert?.();

    await expect(applying).resolves.toBe(1);
  });

  it("does not query ClickHouse for an empty batch", async () => {
    const insert = vi.fn(async () => undefined);
    const query = makeEmptyGenerationQuery();

    await expect(applyMetricStreamEventsToClickHouse({ insert, query }, [])).resolves.toBe(0);
    expect(insert).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("does not query ClickHouse for IMU-only batches", async () => {
    const insert = vi.fn(async () => undefined);
    const query = makeEmptyGenerationQuery();

    await expect(applyMetricStreamEventsToClickHouse({ insert, query }, [imuEvent])).resolves.toBe(
      0,
    );
    expect(insert).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("flushes rows at the maximum write size before processing the next event", async () => {
    const insert = vi.fn(async () => undefined);
    const heartbeat = vi.fn(async () => undefined);
    const events = Array.from({ length: 1001 }, (_, index) => ({
      ...heartRateEvent,
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }));

    await applyMetricStreamEventsToClickHouse(
      { insert, query: makeEmptyGenerationQuery() },
      events,
      {
        topic: "metric-stream-v1",
        partition: 2,
        eventOffsets: events.map((_, index) => String(index)),
        heartbeat,
      },
    );

    expect(insert).toHaveBeenCalledTimes(2);
    expect(insertedValues(insert, 0)).toHaveLength(1000);
    expect(insertedValues(insert, 1)).toHaveLength(1);
    expect(heartbeat).toHaveBeenCalledTimes(2);
  });

  it("acknowledges a correlated batch only after its rows are applied", async () => {
    const command = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);
    const heartbeat = vi.fn(async () => undefined);
    const query = makeEmptyGenerationQuery();
    const marker = createMetricStreamBatchCompletedEvent(
      {
        operationId: "30000000-0000-4000-8000-000000000001",
        batchId: "heart-rate-1",
        datasetKeys: ["recovery"],
      },
      1,
    );

    const applied = await applyMetricStreamEventsToClickHouse(
      { command, insert, query },
      [heartRateEvent, marker],
      {
        topic: "metric-stream-v1",
        partition: 2,
        eventOffsets: ["41", "42"],
        heartbeat,
      },
    );

    expect(applied).toBe(1);
    expect(insert.mock.invocationCallOrder[0]).toBeLessThan(
      command.mock.invocationCallOrder[0] ?? 0,
    );
    expect(heartbeat.mock.invocationCallOrder[0]).toBeLessThan(
      command.mock.invocationCallOrder[0] ?? 0,
    );
    expect(command).toHaveBeenCalledWith({
      query: expect.stringContaining(
        `INSERT INTO ${METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE}`,
      ),
      query_params: {
        operation_id: "30000000-0000-4000-8000-000000000001",
        batch_id: "heart-rate-1",
        dataset_keys: ["recovery"],
        expected_event_count: 1,
        topic: "metric-stream-v1",
        partition: 2,
        marker_offset: "42",
      },
    });
  });

  it("requires Kafka position evidence before acknowledging a correlated batch", async () => {
    const marker = createMetricStreamBatchCompletedEvent(
      {
        operationId: "30000000-0000-4000-8000-000000000001",
        batchId: "heart-rate-1",
        datasetKeys: ["recovery"],
      },
      1,
    );

    await expect(
      applyMetricStreamEventsToClickHouse(
        {
          command: vi.fn(async () => undefined),
          insert: vi.fn(async () => undefined),
        },
        [marker],
      ),
    ).rejects.toThrow("processing marker requires Kafka batch context");
  });

  it("requires the marker's Kafka offset before acknowledging a correlated batch", async () => {
    const marker = createMetricStreamBatchCompletedEvent(
      {
        operationId: "30000000-0000-4000-8000-000000000001",
        batchId: "heart-rate-1",
        datasetKeys: ["recovery"],
      },
      1,
    );

    await expect(
      applyMetricStreamEventsToClickHouse(
        {
          command: vi.fn(async () => undefined),
          insert: vi.fn(async () => undefined),
        },
        [marker],
        {
          topic: "metric-stream-v1",
          partition: 2,
          eventOffsets: [],
          heartbeat: vi.fn(async () => undefined),
        },
      ),
    ).rejects.toThrow("processing marker is missing its Kafka offset");
  });

  it("requires a command-capable client before acknowledging a correlated batch", async () => {
    const marker = createMetricStreamBatchCompletedEvent(
      {
        operationId: "30000000-0000-4000-8000-000000000001",
        batchId: "heart-rate-1",
        datasetKeys: ["recovery"],
      },
      1,
    );

    await expect(
      applyMetricStreamEventsToClickHouse({ insert: vi.fn(async () => undefined) }, [marker], {
        topic: "metric-stream-v1",
        partition: 2,
        eventOffsets: ["42"],
        heartbeat: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow(
      "ClickHouse metric-stream processing acknowledgement requires a command-capable client",
    );
  });

  it("does not acknowledge a correlated batch fenced by account erasure", async () => {
    const command = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({ json: async () => [{ operation_hash: "f".repeat(64) }] }));
    const marker = createMetricStreamBatchCompletedEvent(
      {
        operationId: "30000000-0000-4000-8000-000000000001",
        batchId: "heart-rate-1",
        datasetKeys: ["recovery"],
      },
      1,
    );

    await expect(
      applyMetricStreamEventsToClickHouse(
        { command, insert: vi.fn(async () => undefined), query },
        [marker],
        {
          topic: "metric-stream-v1",
          partition: 2,
          eventOffsets: ["42"],
          heartbeat: vi.fn(async () => undefined),
        },
      ),
    ).resolves.toBe(0);

    expect(query).toHaveBeenCalledOnce();
    expect(command).not.toHaveBeenCalled();
  });

  it("tombstones an event when the provider generation fence advances during insertion", async () => {
    const command = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);
    const query = vi.fn(async (options: { query: string }) => ({
      json: async () =>
        options.query.includes(ACCOUNT_ERASURE_FENCE_TABLE)
          ? []
          : [
              {
                generation: "1",
                provider_id: heartRateEvent.providerId,
                user_id: heartRateEvent.userId,
              },
            ],
    }));

    const applied = await applyMetricStreamEventsToClickHouse({ command, insert, query }, [
      heartRateEvent,
    ]);

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        values: [expect.objectContaining({ id: heartRateEvent.id, generation: 0 })],
      }),
    );
    expect(insert.mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder[1] ?? 0);
    expect(command).toHaveBeenCalledWith({
      query: expect.stringContaining(`INSERT INTO ${METRIC_STREAM_TABLE}`),
      query_params: {
        row_ids: [heartRateEvent.id],
      },
    });
    expect(applied).toBe(0);
  });

  it("never writes events for an account with an active erasure fence", async () => {
    const command = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({
      json: async () => [
        {
          user_hash: createHash("sha256").update(heartRateEvent.userId).digest("hex"),
        },
      ],
    }));

    const applied = await applyMetricStreamEventsToClickHouse({ command, insert, query }, [
      heartRateEvent,
    ]);

    expect(insert).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect(applied).toBe(0);
  });

  it("tombstones events older than the active provider generation fence", async () => {
    const command = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);
    const query = vi.fn(async (options: { query: string }) => ({
      json: async () =>
        options.query.includes(ACCOUNT_ERASURE_FENCE_TABLE)
          ? []
          : [
              {
                generation: "2",
                provider_id: heartRateEvent.providerId,
                user_id: heartRateEvent.userId,
              },
            ],
    }));

    const applied = await applyMetricStreamEventsToClickHouse({ command, insert, query }, [
      { ...heartRateEvent, generation: 1 },
      {
        ...heartRateEvent,
        generation: 2,
        id: "10000000-0000-4000-8000-000000000005",
      },
    ]);

    expect(applied).toBe(1);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        values: [
          expect.objectContaining({ generation: 1 }),
          expect.objectContaining({ generation: 2 }),
        ],
      }),
    );
    expect(command).toHaveBeenCalledWith({
      query: expect.stringContaining(`INSERT INTO ${METRIC_STREAM_TABLE}`),
      query_params: {
        row_ids: [heartRateEvent.id],
      },
    });
  });

  it("replays archived v1 deletes without a v2 acknowledgement", async () => {
    const command = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);
    const query = makeEmptyGenerationQuery();
    const archivedDeleteEvent = {
      version: 1,
      eventType: "metric_stream_deleted",
      scope: { activityId: "20000000-0000-4000-8000-000000000001" },
      partitionKey: "activity:20000000-0000-4000-8000-000000000001",
    } satisfies MetricStreamDeletedEventV1;

    const applied = await applyMetricStreamEventsToClickHouse({ command, insert, query }, [
      archivedDeleteEvent,
    ]);

    expect(applied).toBe(0);
    expect(command).toHaveBeenCalledTimes(1);
    expect(firstCommandQuery(command)).toContain(`INSERT INTO ${METRIC_STREAM_TABLE}`);
    expect(firstCommandQuery(command)).toContain(
      `lower(hex(SHA256(toString(latest_row.2)))) NOT IN`,
    );
    expect(firstCommandQuery(command)).toContain(`FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL`);
    expect(insert).not.toHaveBeenCalled();
  });

  it("skips an acknowledged current delete during consumer redelivery", async () => {
    const command = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);
    const query = vi.fn(
      async (_options: {
        query: string;
        query_params?: Record<string, unknown>;
        format: "JSONEachRow";
      }) => ({ json: async () => [{ acknowledgement_count: 1 }] }),
    );
    const deleteEvent = createCurrentMetricStreamDeletedEvent({
      userId: heartRateEvent.userId,
      providerId: "garmin-dump",
    });

    const applied = await applyMetricStreamEventsToClickHouse({ command, insert, query }, [
      deleteEvent,
    ]);

    expect(applied).toBe(0);
    expect(query).toHaveBeenCalledWith({
      query: expect.stringMatching(
        /SELECT 1 AS acknowledgement_count[\s\S]+metric_stream_delete_acknowledgement[\s\S]+LIMIT 1/,
      ),
      query_params: { event_id: deleteEvent.eventId },
      format: "JSONEachRow",
    });
    expect(query.mock.calls[0]?.[0]?.query).not.toContain("FINAL");
    expect(command).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("applies a current delete when no acknowledgement exists", async () => {
    const command = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({ json: async () => [] }));
    const deleteEvent = createCurrentMetricStreamDeletedEvent({
      activityId: "20000000-0000-4000-8000-000000000001",
    });

    await applyMetricStreamEventsToClickHouse({ command, insert, query }, [deleteEvent]);

    expect(command).toHaveBeenCalledTimes(2);
    expect(firstCommandQuery(command)).toContain(`INSERT INTO ${METRIC_STREAM_TABLE}`);
  });

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

    expect(command).toHaveBeenCalledTimes(3);
    expect(firstCommandQuery(command)).toContain(
      "candidate_row.external_id = {external_id_0:String}",
    );
    expect(firstCommandQuery(command)).toContain(
      "candidate_row.external_id = {external_id_1:String}",
    );
    expect(command).toHaveBeenNthCalledWith(1, {
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

  it("batches adjacent current deletes with the same revision while consuming", async () => {
    const command = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({ json: async () => [] }));
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

    await applyMetricStreamEventsToClickHouse(
      { command, insert: vi.fn(async () => undefined), query },
      [firstDelete, secondDelete],
    );

    expect(command).toHaveBeenCalledTimes(3);
    expect(firstCommandQuery(command)).toContain("external_id_0");
    expect(firstCommandQuery(command)).toContain("external_id_1");
  });

  it("does not batch adjacent current deletes from different revisions", async () => {
    const command = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({ json: async () => [] }));
    const firstDelete = createMetricStreamDeletedEvent(
      { userId: heartRateEvent.userId, providerId: heartRateEvent.providerId },
      operationRevision,
    );
    const secondDelete = createMetricStreamDeletedEvent(
      { userId: heartRateEvent.userId, providerId: heartRateEvent.providerId },
      "1000000000000001",
    );

    await applyMetricStreamEventsToClickHouse(
      { command, insert: vi.fn(async () => undefined), query },
      [firstDelete, secondDelete],
    );

    expect(command).toHaveBeenCalledTimes(4);
    expect(command).toHaveBeenNthCalledWith(1, {
      query: expect.stringContaining(`INSERT INTO ${METRIC_STREAM_TABLE}`),
      query_params: expect.objectContaining({
        replacement_version: "2000000000000000",
      }),
    });
    expect(command).toHaveBeenNthCalledWith(3, {
      query: expect.stringContaining(`INSERT INTO ${METRIC_STREAM_TABLE}`),
      query_params: expect.objectContaining({
        replacement_version: "2000000000000002",
      }),
    });
  });

  it("does not batch same-revision deletes across a replacement row", async () => {
    const command = vi.fn(async () => undefined);
    const query = makeEmptyGenerationQuery();
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

    await applyMetricStreamEventsToClickHouse(
      { command, insert: vi.fn(async () => undefined), query },
      [firstDelete, heartRateEvent, secondDelete],
    );

    expect(command).toHaveBeenCalledTimes(4);
    expect(firstCommandQuery(command)).toContain("{external_id:String}");
    expect(firstCommandQuery(command)).not.toContain("external_id_0");
    expect(command).toHaveBeenNthCalledWith(3, {
      query: expect.stringContaining("{external_id:String}"),
      query_params: expect.any(Object),
    });
    expect(command).toHaveBeenNthCalledWith(3, {
      query: expect.not.stringContaining("external_id_0"),
      query_params: expect.any(Object),
    });
  });

  it("marks matching ClickHouse rows deleted before inserting replacement rows", async () => {
    const command = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);
    const query = makeEmptyGenerationQuery();
    const deleteEvent = createCurrentMetricStreamDeletedEvent({
      activityId: "20000000-0000-4000-8000-000000000001",
    });

    const applied = await applyMetricStreamEventsToClickHouse({ command, insert, query }, [
      deleteEvent,
      { ...heartRateEvent, activityId: "20000000-0000-4000-8000-000000000001" },
    ]);

    expect(applied).toBe(1);
    expect(command).toHaveBeenNthCalledWith(1, {
      query: expect.stringContaining(`INSERT INTO ${METRIC_STREAM_TABLE}`),
      query_params: {
        activity_id: "20000000-0000-4000-8000-000000000001",
        replacement_version: "2000000000000000",
      },
    });
    expect(String(firstCommandQuery(command))).toContain("1 AS is_deleted");
    expect(String(firstCommandQuery(command))).toContain(
      "candidate_row.activity_id = {activity_id:UUID}",
    );
    expect(String(firstCommandQuery(command))).toContain("latest_row.1 = {activity_id:UUID}");
    expect(command).toHaveBeenNthCalledWith(2, {
      query: expect.stringContaining("ingest.metric_stream_delete_acknowledgement"),
      query_params: { event_id: deleteEvent.eventId },
    });
    expect(insert).toHaveBeenCalledWith({
      table: METRIC_STREAM_TABLE,
      values: [expect.objectContaining({ id: heartRateEvent.id })],
      format: "JSONEachRow",
      clickhouse_settings: { date_time_input_format: "best_effort" },
    });
  });

  it("flushes row batches on both sides of a replacement delete", async () => {
    const command = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);
    const query = makeEmptyGenerationQuery();
    const secondHeartRateEvent = {
      ...heartRateEvent,
      id: "10000000-0000-4000-8000-000000000004",
      recordedAt: "2026-06-06T19:01:00.000Z",
    } satisfies MetricStreamEventV1;

    const applied = await applyMetricStreamEventsToClickHouse({ command, insert, query }, [
      heartRateEvent,
      createCurrentMetricStreamDeletedEvent({
        activityId: "20000000-0000-4000-8000-000000000001",
      }),
      secondHeartRateEvent,
    ]);

    expect(applied).toBe(2);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenNthCalledWith(1, {
      table: METRIC_STREAM_TABLE,
      values: [expect.objectContaining({ id: heartRateEvent.id })],
      format: "JSONEachRow",
      clickhouse_settings: { date_time_input_format: "best_effort" },
    });
    expect(insert).toHaveBeenNthCalledWith(2, {
      table: METRIC_STREAM_TABLE,
      values: [expect.objectContaining({ id: secondHeartRateEvent.id })],
      format: "JSONEachRow",
      clickhouse_settings: { date_time_input_format: "best_effort" },
    });
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("renders every supported replacement scope predicate into the tombstone insert", async () => {
    const command = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);

    await applyMetricStreamEventsToClickHouse({ command, insert }, [
      createCurrentMetricStreamDeletedEvent({
        userId: "10000000-0000-4000-8000-000000000001",
        providerId: "fitbit",
        externalId: null,
        channel: "body_weight",
        activityId: "20000000-0000-4000-8000-000000000001",
        recordedAtStart: "2026-03-01T00:00:00.000Z",
        recordedAtEnd: "2026-03-02T00:00:00.000Z",
      }),
    ]);

    expect(insert).not.toHaveBeenCalled();
    expect(command).toHaveBeenCalledWith({
      query: expect.stringContaining(`INSERT INTO ${METRIC_STREAM_TABLE}`),
      query_params: {
        user_id: "10000000-0000-4000-8000-000000000001",
        provider_id: "fitbit",
        channel: "body_weight",
        activity_id: "20000000-0000-4000-8000-000000000001",
        recorded_at_start: "2026-03-01T00:00:00.000Z",
        recorded_at_end: "2026-03-02T00:00:00.000Z",
        replacement_version: "2000000000000000",
      },
    });
    const query = firstCommandQuery(command);
    expect(query).toContain("candidate_row.user_id = {user_id:UUID}");
    expect(query).toContain("candidate_row.provider_id = {provider_id:String}");
    expect(query).toContain("candidate_row.external_id IS NULL");
    expect(query).toContain("candidate_row.channel = {channel:String}");
    expect(query).toContain("candidate_row.activity_id = {activity_id:UUID}");
    expect(query).toContain(
      "candidate_row.recorded_at >= parseDateTime64BestEffort({recorded_at_start:String})",
    );
    expect(query).toContain(
      "candidate_row.recorded_at < parseDateTime64BestEffort({recorded_at_end:String})",
    );
    expect(query).toContain("latest_row.2 = {user_id:UUID}");
    expect(query).toContain("latest_row.5 = {provider_id:String}");
    expect(query).toContain("latest_row.6 IS NULL");
    expect(query).toContain("latest_row.4 = {channel:String}");
    expect(query).toContain("latest_row.1 = {activity_id:UUID}");
    expect(query).toContain(
      "latest_row.3 >= parseDateTime64BestEffort({recorded_at_start:String})",
    );
    expect(query).toContain("latest_row.3 < parseDateTime64BestEffort({recorded_at_end:String})");
  });

  it("binds non-null external IDs in replacement scopes", async () => {
    const command = vi.fn(async () => undefined);

    await applyMetricStreamEventsToClickHouse({ command, insert: vi.fn(async () => undefined) }, [
      createCurrentMetricStreamDeletedEvent({
        providerId: "fitbit",
        externalId: "measurement-1",
      }),
    ]);

    expect(command).toHaveBeenCalledWith({
      query: expect.stringContaining("candidate_row.external_id = {external_id:String}"),
      query_params: {
        provider_id: "fitbit",
        external_id: "measurement-1",
        replacement_version: "2000000000000000",
      },
    });
    expect(firstCommandQuery(command)).toContain("latest_row.6 = {external_id:String}");
  });

  it("applies an account-wide replacement delete using only the user predicate", async () => {
    const command = vi.fn(async () => undefined);

    await applyMetricStreamEventsToClickHouse(
      { command, insert: vi.fn(async () => undefined), query: makeEmptyGenerationQuery() },
      [
        createCurrentMetricStreamDeletedEvent({
          userId: "10000000-0000-4000-8000-000000000001",
        }),
      ],
    );

    expect(firstCommandQuery(command)).toContain("candidate_row.user_id = {user_id:UUID}");
    expect(firstCommandQuery(command)).toContain("latest_row.2 = {user_id:UUID}");
    expect(firstCommandQuery(command)).toContain(`FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL`);
  });

  it("rejects replacement delete scopes that produce no ClickHouse conditions", async () => {
    await expect(
      markMetricStreamScopeDeletedInClickHouse(
        { command: vi.fn(async () => undefined), insert: vi.fn(async () => undefined) },
        {},
      ),
    ).rejects.toThrow("Metric stream delete scope produced no ClickHouse conditions");
  });

  it("requires a command-capable client before applying replacement deletes", async () => {
    await expect(
      applyMetricStreamEventsToClickHouse({ insert: vi.fn(async () => undefined) }, [
        createCurrentMetricStreamDeletedEvent({
          activityId: "20000000-0000-4000-8000-000000000001",
        }),
      ]),
    ).rejects.toThrow("ClickHouse metric-stream deletion requires a command-capable client");
  });
});

describe("runMetricStreamClickHouseSinkFromEnv", () => {
  it("consumes Redpanda events and inserts them into ClickHouse", async () => {
    const client = {
      insert: vi.fn(async () => undefined),
      query: makeEmptyGenerationQuery(),
    };
    const consumer = {
      connect: vi.fn(async () => undefined),
      observeGroupLifecycle: vi.fn(),
      subscribe: vi.fn(async () => undefined),
      run: vi.fn(async () => undefined),
    };
    const runMetricStreamEventConsumer = vi.fn(
      async (_options: RunMetricStreamEventConsumerOptions) => undefined,
    );
    const createKafkaMetricStreamConsumerFromEnv = vi.fn(() => ({
      consumer,
      quarantine: {
        connect: vi.fn(async () => undefined),
        write: vi.fn(async () => undefined),
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

    const { runMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink.ts");

    await runMetricStreamClickHouseSinkFromEnv(new MetricStreamConsumerReadiness());

    expect(createKafkaMetricStreamConsumerFromEnv).toHaveBeenCalledWith(
      "metric-stream-clickhouse-sink",
    );
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
  });

  it("requires an insert-capable ClickHouse client", async () => {
    vi.doMock("../db/clickhouse.ts", () => ({
      createClickHouseClientFromEnv: vi.fn(() => ({})),
    }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv: vi.fn(),
      runMetricStreamEventConsumer: vi.fn(),
    }));

    const { runMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink.ts");

    await expect(
      runMetricStreamClickHouseSinkFromEnv(new MetricStreamConsumerReadiness()),
    ).rejects.toThrow("ClickHouse metric-stream sink requires an insert-capable client");
  });

  it("requires Kafka group lifecycle events for the readiness check", async () => {
    vi.doMock("../db/clickhouse.ts", () => ({
      createClickHouseClientFromEnv: vi.fn(() => ({ insert: vi.fn(async () => undefined) })),
    }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv: vi.fn(() => ({
        consumer: {
          connect: vi.fn(async () => undefined),
          subscribe: vi.fn(async () => undefined),
          run: vi.fn(async () => undefined),
        },
        quarantine: {
          connect: vi.fn(async () => undefined),
          write: vi.fn(async () => undefined),
        },
        topic: "metric-stream-v1",
      })),
      runMetricStreamEventConsumer: vi.fn(),
    }));

    const { runMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink.ts");

    await expect(
      runMetricStreamClickHouseSinkFromEnv(new MetricStreamConsumerReadiness()),
    ).rejects.toThrow("ClickHouse metric-stream sink requires Kafka group lifecycle events");
  });

  it("starts the readiness server before starting the ClickHouse sink", async () => {
    const readinessServer = Object.assign(new EventEmitter(), {
      listen: vi.fn(() => readinessServer),
      unref: vi.fn(),
    });
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
    };

    vi.doMock("../db/clickhouse.ts", () => ({
      createClickHouseClientFromEnv: vi.fn(() => ({ insert: vi.fn(async () => undefined) })),
    }));
    vi.doMock("./consumer-readiness.ts", () => ({
      MetricStreamConsumerReadiness: class MetricStreamConsumerReadiness {},
      createMetricStreamConsumerReadinessServer,
    }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv: vi.fn(() => ({
        consumer,
        quarantine: {
          connect: vi.fn(async () => undefined),
          write: vi.fn(async () => undefined),
        },
        topic: "metric-stream-v1",
      })),
      runMetricStreamEventConsumer,
    }));

    const { startMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink.ts");

    const starting = startMetricStreamClickHouseSinkFromEnv();
    await Promise.resolve();

    expect(runMetricStreamEventConsumer).not.toHaveBeenCalled();
    readinessServer.emit("listening");
    await starting;

    expect(listen).toHaveBeenCalledWith(3001, "0.0.0.0");
    expect(unref).toHaveBeenCalledOnce();
    expect(listen.mock.invocationCallOrder[0]).toBeLessThan(
      runMetricStreamEventConsumer.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(runMetricStreamEventConsumer).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycleListener: expect.any(Object) }),
    );
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

    const { startMetricStreamClickHouseSinkFromEnv } = await import("./clickhouse-sink.ts");
    const starting = startMetricStreamClickHouseSinkFromEnv();
    const error = new Error("listen EADDRINUSE: address already in use 0.0.0.0:3001");
    readinessServer.emit("error", error);

    await expect(starting).rejects.toThrow(error.message);
    expect(runMetricStreamEventConsumer).not.toHaveBeenCalled();
  });
});
