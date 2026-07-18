import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMetricStreamEventsToClickHouse,
  insertMetricStreamEventsIntoClickHouse,
  mapMetricStreamEventToClickHouseRow,
  markMetricStreamScopeDeletedInClickHouse,
} from "./clickhouse-sink.ts";
import { METRIC_STREAM_TABLE } from "./clickhouse-table.ts";
import { createMetricStreamDeletedEvent, type MetricStreamEventV1 } from "./events.ts";
import type { RunMetricStreamEventConsumerOptions } from "./redpanda-consumer.ts";

const heartRateEvent = {
  version: 1,
  id: "10000000-0000-4000-8000-000000000001",
  recordedAt: "2026-06-06T19:00:00.000Z",
  userId: "00000000-0000-0000-0000-000000000001",
  providerId: "apple_health",
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

function firstCommandQuery(command: ReturnType<typeof vi.fn>): string {
  const call = command.mock.calls[0]?.[0];
  if (!call || typeof call !== "object" || !("query" in call) || typeof call.query !== "string") {
    throw new Error("expected command call");
  }
  return call.query;
}

afterEach(() => {
  vi.doUnmock("../db/clickhouse.ts");
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
  it("marks matching ClickHouse rows deleted before inserting replacement rows", async () => {
    const command = vi.fn(async () => undefined);
    const insert = vi.fn(async () => undefined);
    const deleteEvent = createMetricStreamDeletedEvent({
      activityId: "20000000-0000-4000-8000-000000000001",
    });

    const applied = await applyMetricStreamEventsToClickHouse({ command, insert }, [
      deleteEvent,
      { ...heartRateEvent, activityId: "20000000-0000-4000-8000-000000000001" },
    ]);

    expect(applied).toBe(1);
    expect(command).toHaveBeenNthCalledWith(1, {
      query: expect.stringContaining(`INSERT INTO ${METRIC_STREAM_TABLE}`),
      query_params: {
        delete_version: expect.any(Number),
        activity_id: "20000000-0000-4000-8000-000000000001",
      },
    });
    expect(String(firstCommandQuery(command))).toContain("1 AS is_deleted");
    expect(String(firstCommandQuery(command))).toContain(
      "toString(activity_id) = {activity_id:String}",
    );
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
    const secondHeartRateEvent = {
      ...heartRateEvent,
      id: "10000000-0000-4000-8000-000000000004",
      recordedAt: "2026-06-06T19:01:00.000Z",
    } satisfies MetricStreamEventV1;

    const applied = await applyMetricStreamEventsToClickHouse({ command, insert }, [
      heartRateEvent,
      createMetricStreamDeletedEvent({
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
      createMetricStreamDeletedEvent({
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
        delete_version: expect.any(Number),
        user_id: "10000000-0000-4000-8000-000000000001",
        provider_id: "fitbit",
        external_id: null,
        channel: "body_weight",
        activity_id: "20000000-0000-4000-8000-000000000001",
        recorded_at_start: "2026-03-01T00:00:00.000Z",
        recorded_at_end: "2026-03-02T00:00:00.000Z",
      },
    });
    const query = firstCommandQuery(command);
    expect(query).toContain("toString(user_id) = {user_id:String}");
    expect(query).toContain("provider_id = {provider_id:String}");
    expect(query).toContain("external_id = {external_id:String}");
    expect(query).toContain("channel = {channel:String}");
    expect(query).toContain("toString(activity_id) = {activity_id:String}");
    expect(query).toContain("recorded_at >= parseDateTime64BestEffort({recorded_at_start:String})");
    expect(query).toContain("recorded_at < parseDateTime64BestEffort({recorded_at_end:String})");
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
        createMetricStreamDeletedEvent({
          activityId: "20000000-0000-4000-8000-000000000001",
        }),
      ]),
    ).rejects.toThrow("ClickHouse metric-stream replacement requires a command-capable client");
  });
});

describe("runMetricStreamClickHouseSinkFromEnv", () => {
  it("consumes Redpanda events and inserts them into ClickHouse", async () => {
    const client = { insert: vi.fn(async () => undefined) };
    const consumer = {
      connect: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => undefined),
      run: vi.fn(async () => undefined),
    };
    const runMetricStreamEventConsumer = vi.fn(
      async (_options: RunMetricStreamEventConsumerOptions) => undefined,
    );
    const createKafkaMetricStreamConsumerFromEnv = vi.fn(() => ({
      consumer,
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

    await runMetricStreamClickHouseSinkFromEnv();

    expect(createKafkaMetricStreamConsumerFromEnv).toHaveBeenCalledWith(
      "metric-stream-clickhouse-sink",
    );
    expect(runMetricStreamEventConsumer).toHaveBeenCalledWith({
      consumer,
      topic: "metric-stream-v1",
      handleEvents: expect.any(Function),
    });

    const options = runMetricStreamEventConsumer.mock.calls[0]?.[0];
    if (!options) {
      throw new Error("expected consumer options");
    }
    await options.handleEvents([heartRateEvent]);
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

    await expect(runMetricStreamClickHouseSinkFromEnv()).rejects.toThrow(
      "ClickHouse metric-stream sink requires an insert-capable client",
    );
  });
});
