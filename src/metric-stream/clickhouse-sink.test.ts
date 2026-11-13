import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  applyMetricStreamEventsToClickHouse,
  insertMetricStreamEventsIntoClickHouse,
  mapMetricStreamEventToClickHouseRow,
  markMetricStreamScopeDeletedInClickHouse,
  markMetricStreamScopesDeletedInClickHouse,
} from "./clickhouse-sink.ts";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_DELETE_SCOPE_TABLE,
  METRIC_STREAM_PROCESSING_ACKNOWLEDGEMENT_TABLE,
  METRIC_STREAM_TABLE,
} from "./clickhouse-table.ts";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamDeletedEvent,
  type MetricStreamDeletedEventV1,
  type MetricStreamDeleteScopeInput,
  type MetricStreamEventV1,
} from "./events.ts";
import {
  createProcessingMarker,
  expectDeletionAcknowledgementQuery,
  expectMetricStreamInsert,
  firstCommandQuery,
  insertedValues,
  makeActiveGenerationQuery,
  makeEmptyGenerationQuery,
  parseDeletionAcknowledgementInsert,
  processingMarkerFailureCases,
  replacementScopeTestCases,
} from "./test-helpers.ts";

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

describe("insertMetricStreamEventsIntoClickHouse", () => {
  it("inserts non-IMU events into the ingest metric stream table", async () => {
    const insert = vi.fn(async () => undefined);

    const inserted = await insertMetricStreamEventsIntoClickHouse({ insert }, [heartRateEvent]);

    expect(inserted).toBe(1);
    expectMetricStreamInsert(insert, [
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
    ]);
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
    expect(row.vector).toEqual([1, 2, 3]);
    expect(row.metadata).toBe('{"source":"test"}');
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

  it.each([
    {
      label: "omitted optional fields",
      event: {
        version: 1 as const,
        id: "10000000-0000-4000-8000-000000000003",
        recordedAt: "2026-06-06T19:00:00.000Z",
        userId: "00000000-0000-0000-0000-000000000001",
        providerId: "apple_health",
        generation: 0,
        sourceType: "api",
        channel: "heart_rate",
      },
      expectNullable: true,
    },
    { label: "explicit null vector and metadata", event: heartRateEvent, expectNullable: false },
  ])("maps $label into ClickHouse values", ({ event, expectNullable }) => {
    const row = mapMetricStreamEventToClickHouseRow(event);
    expect(row.vector).toEqual([]);
    expect(row.metadata).toBe("null");
    if (expectNullable) {
      expect(row.external_id).toBeNull();
      expect(row.device_id).toBeNull();
      expect(row.activity_id).toBeNull();
      expect(row.scalar).toBeNull();
      expect(row.point).toBeNull();
    }
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

  it.each([
    { label: "empty", events: [] },
    { label: "IMU-only", events: [imuEvent] },
  ])("does not query ClickHouse for $label batches", async ({ events }) => {
    const insert = vi.fn(async () => undefined);
    const query = makeEmptyGenerationQuery();

    await expect(applyMetricStreamEventsToClickHouse({ insert, query }, events)).resolves.toBe(0);
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

  const processingMarker = createProcessingMarker();
  it.each(processingMarkerFailureCases)(
    "requires $reason before acknowledging a correlated batch",
    async ({ client, context, error }) => {
      await expect(
        applyMetricStreamEventsToClickHouse(client, [processingMarker], context),
      ).rejects.toThrow(error);
    },
  );

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
    const query = makeActiveGenerationQuery("1", heartRateEvent.providerId, heartRateEvent.userId);

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
    const query = makeActiveGenerationQuery("2", heartRateEvent.providerId, heartRateEvent.userId);

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
      }) => ({ json: async () => [{ event_id: deleteEvent.eventId }] }),
    );
    const deleteEvent = createCurrentMetricStreamDeletedEvent({
      userId: heartRateEvent.userId,
      providerId: "garmin-dump",
    });

    const applied = await applyMetricStreamEventsToClickHouse({ command, insert, query }, [
      deleteEvent,
    ]);

    expect(applied).toBe(0);
    expectDeletionAcknowledgementQuery(query, [deleteEvent.eventId]);
    expect(query.mock.calls[0]?.[0]?.query).not.toContain("FINAL");
    expect(command).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([
    { label: "partial", eventCount: 3, acknowledgedIndexes: [1] },
    { label: "fully", eventCount: 3, acknowledgedIndexes: [0, 1, 2] },
    { label: "100-event boundary", eventCount: 100, acknowledgedIndexes: [] },
    { label: "101-event boundary", eventCount: 101, acknowledgedIndexes: [] },
  ])(
    "replays exact unacknowledged IDs for a $label v3 run",
    async ({ eventCount, acknowledgedIndexes }) => {
      const deletes = Array.from({ length: eventCount }, (_, index) =>
        createCurrentMetricStreamDeletedEvent({
          userId: heartRateEvent.userId,
          providerId: heartRateEvent.providerId,
          externalId: `ack-boundary-${index}`,
        }),
      );
      const acknowledgedIds = new Set(
        deletes
          .filter((_, index) => acknowledgedIndexes.includes(index))
          .map(({ eventId }) => eventId),
      );
      const lookups: string[][] = [];
      const query = vi.fn(async (options: { query_params?: Record<string, unknown> }) => ({
        json: async () => {
          const ids = z.array(z.uuid()).parse(options.query_params?.event_ids);
          lookups.push(ids);
          return ids.filter((id) => acknowledgedIds.has(id)).map((event_id) => ({ event_id }));
        },
      }));
      const command = vi.fn(async (_options: { query: string }) => undefined);

      await applyMetricStreamEventsToClickHouse(
        { command, insert: vi.fn(async () => undefined), query },
        deletes,
      );

      const eventIds = deletes.map(({ eventId }) => eventId);
      const expectedLookupBatches = Array.from(
        { length: Math.ceil(eventCount / 100) },
        (_, batch) => eventIds.slice(batch * 100, (batch + 1) * 100),
      );
      const expectedReceiptBatches = expectedLookupBatches
        .map((batch) => batch.filter((eventId) => !acknowledgedIds.has(eventId)))
        .filter((batch) => batch.length > 0);
      expect(lookups).toEqual(expectedLookupBatches);
      expect(
        command.mock.calls
          .map(([options]) => options.query)
          .filter((query) => query.includes(METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE))
          .map(parseDeletionAcknowledgementInsert),
      ).toEqual(expectedReceiptBatches);
      expect(query).toHaveBeenCalledTimes(expectedLookupBatches.length);
      if (expectedReceiptBatches.length === 0) expect(command).not.toHaveBeenCalled();
    },
  );

  it("applies a current delete when no acknowledgement exists", async () => {
    const command = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({ json: async () => [] }));
    const deleteEvent = createCurrentMetricStreamDeletedEvent({
      activityId: "20000000-0000-4000-8000-000000000001",
    });

    await applyMetricStreamEventsToClickHouse({ command, insert, query }, [deleteEvent]);

    expect(command).toHaveBeenCalledTimes(3);
    expect(command).toHaveBeenNthCalledWith(1, {
      query: `INSERT INTO ${METRIC_STREAM_DELETE_SCOPE_TABLE} FORMAT JSONEachRow\n${JSON.stringify({
        user_id: null,
        provider_id: null,
        activity_id: "20000000-0000-4000-8000-000000000001",
        channel: null,
        external_id: null,
        external_id_set: 0,
        recorded_at_start: null,
        recorded_at_end: null,
        operation_revision: operationRevision,
      })}`,
      clickhouse_settings: { date_time_input_format: "best_effort" },
    });
    expect(firstCommandQuery(command)).toContain(`INSERT INTO ${METRIC_STREAM_TABLE}`);
  });

  it.each([
    { label: "older", scopeVersion: "1", tombstoned: true },
    { label: "equal", scopeVersion: "0", tombstoned: false },
  ])(
    "tombstones an $label row only when its persisted delete scope is newer",
    async ({ scopeVersion, tombstoned }) => {
      const insert = vi.fn(async () => undefined);
      const query = vi.fn(async (options: { query: string }) => ({
        json: async () =>
          options.query.includes(METRIC_STREAM_DELETE_SCOPE_TABLE)
            ? [{ row_index: 0, version: scopeVersion }]
            : [],
      }));

      await applyMetricStreamEventsToClickHouse({ insert, query }, [heartRateEvent]);

      expect(query).toHaveBeenCalledWith({
        query: expect.stringContaining(`FROM ${METRIC_STREAM_DELETE_SCOPE_TABLE} FINAL`),
        query_params: {
          row_indexes: [0],
          row_user_ids: [heartRateEvent.userId],
          provider_ids: [heartRateEvent.providerId],
          activity_ids: [null],
          channels: [heartRateEvent.channel],
          external_ids: [heartRateEvent.externalId],
          recorded_ats: [heartRateEvent.recordedAt],
          versions: ["0"],
          user_ids: [heartRateEvent.userId],
        },
        format: "JSONEachRow",
      });
      if (tombstoned) {
        expectMetricStreamInsert(
          insert,
          [expect.objectContaining({ id: heartRateEvent.id, is_deleted: 1, version: "1" })],
          2,
        );
      } else {
        expect(insert).toHaveBeenCalledOnce();
      }
    },
  );

  it("rejects an invalid persisted delete-scope version", async () => {
    const query = vi.fn(async (options: { query: string }) => ({
      json: async () =>
        options.query.includes(METRIC_STREAM_DELETE_SCOPE_TABLE)
          ? [{ row_index: 0, version: "invalid-version" }]
          : [],
    }));

    await expect(
      applyMetricStreamEventsToClickHouse({ insert: vi.fn(async () => undefined), query }, [
        heartRateEvent,
      ]),
    ).rejects.toThrow();
  });

  it("requires a query-capable client to enforce persisted delete scopes", async () => {
    await expect(
      applyMetricStreamEventsToClickHouse({ insert: vi.fn(async () => undefined) }, [
        heartRateEvent,
      ]),
    ).rejects.toThrow("ClickHouse metric-stream ingestion requires a query-capable client");
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
      "WHERE (candidate_row.user_id = {user_id_0:UUID} AND candidate_row.provider_id = {provider_id_0:String} AND candidate_row.external_id = {external_id_0:String}) OR (candidate_row.user_id = {user_id_1:UUID} AND candidate_row.provider_id = {provider_id_1:String} AND candidate_row.external_id = {external_id_1:String})\n          GROUP BY candidate_row.id, candidate_row.user_id,\n            candidate_row.provider_id, candidate_row.recorded_at",
    );
    expect(firstCommandQuery(command)).toContain("latest_row.2 = {user_id_0:UUID}");
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

  it("leaves a failed delete chunk unacknowledged and stops before replacement rows", async () => {
    const deletes = Array.from({ length: 101 }, (_, index) =>
      createCurrentMetricStreamDeletedEvent({
        userId: heartRateEvent.userId,
        providerId: heartRateEvent.providerId,
        externalId: `chunk-failure-${index}`,
      }),
    );
    const acknowledgedIds: string[] = [];
    let streamWrites = 0;
    const command = vi.fn(
      async (options: { query: string; query_params?: Record<string, unknown> }) => {
        if (options.query.startsWith(`INSERT INTO ${METRIC_STREAM_TABLE} (`)) {
          streamWrites += 1;
          if (streamWrites === 2) throw new Error("second chunk rejected");
        } else if (options.query.includes(METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE)) {
          acknowledgedIds.push(...parseDeletionAcknowledgementInsert(options.query));
        }
      },
    );
    const insert = vi.fn(async () => undefined);
    const query = makeEmptyGenerationQuery();

    await expect(
      applyMetricStreamEventsToClickHouse({ command, insert, query }, [...deletes, heartRateEvent]),
    ).rejects.toThrow("second chunk rejected");

    expect(streamWrites).toBe(2);
    expect(acknowledgedIds).toEqual(deletes.slice(0, 100).map((event) => event.eventId));
    expect(insert).not.toHaveBeenCalled();
  });

  it("stops before following rows when receipt insertion fails", async () => {
    const deleteEvent = createCurrentMetricStreamDeletedEvent({
      userId: heartRateEvent.userId,
      providerId: heartRateEvent.providerId,
    });
    const command = vi.fn(async (options: { query: string }) => {
      if (options.query.includes(METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE)) {
        throw new Error("receipt rejected");
      }
    });
    const insert = vi.fn(async () => undefined);

    await expect(
      applyMetricStreamEventsToClickHouse({ command, insert, query: makeEmptyGenerationQuery() }, [
        deleteEvent,
        heartRateEvent,
      ]),
    ).rejects.toThrow("receipt rejected");

    expect(firstCommandQuery(command)).toContain(`INSERT INTO ${METRIC_STREAM_TABLE}`);
    expect(insert).not.toHaveBeenCalled();
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

    expect(command).toHaveBeenCalledTimes(6);
    expect(command).toHaveBeenNthCalledWith(2, {
      query: expect.stringContaining(`INSERT INTO ${METRIC_STREAM_TABLE}`),
      query_params: expect.objectContaining({
        replacement_version: "2000000000000000",
      }),
    });
    expect(command).toHaveBeenNthCalledWith(5, {
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

    expect(command).toHaveBeenCalledTimes(6);
    expect(firstCommandQuery(command)).toContain("{external_id:String}");
    expect(firstCommandQuery(command)).not.toContain("external_id_0");
    expect(command).toHaveBeenNthCalledWith(5, {
      query: expect.stringContaining("{external_id:String}"),
      query_params: expect.any(Object),
    });
    expect(command).toHaveBeenNthCalledWith(5, {
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
    expect(command).toHaveBeenNthCalledWith(2, {
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
    expect(command).toHaveBeenNthCalledWith(3, {
      query: `INSERT INTO ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE} (event_id)\n        FORMAT JSONEachRow\n${JSON.stringify({ event_id: deleteEvent.eventId })}`,
    });
    expectMetricStreamInsert(insert, [expect.objectContaining({ id: heartRateEvent.id })]);
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
    expectMetricStreamInsert(insert, [expect.objectContaining({ id: heartRateEvent.id })], 1);
    expectMetricStreamInsert(insert, [expect.objectContaining({ id: secondHeartRateEvent.id })], 2);
    expect(command).toHaveBeenCalledTimes(3);
  });

  it.each(replacementScopeTestCases)(
    "renders $label replacement scope predicates",
    async ({ scope, params, candidate, latest, accountFence }) => {
      const command = vi.fn(async () => undefined);
      const insert = vi.fn(async () => undefined);
      await applyMetricStreamEventsToClickHouse(
        { command, insert, query: makeEmptyGenerationQuery() },
        [createCurrentMetricStreamDeletedEvent(scope)],
      );

      expect(insert).not.toHaveBeenCalled();
      expect(command).toHaveBeenCalledWith({
        query: expect.stringContaining(`INSERT INTO ${METRIC_STREAM_TABLE}`),
        query_params: { ...params, replacement_version: "2000000000000000" },
      });
      const query = firstCommandQuery(command);
      for (const predicate of candidate) expect(query).toContain(predicate);
      for (const predicate of latest) expect(query).toContain(predicate);
      if (accountFence) expect(query).toContain(`FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL`);
    },
  );

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
