import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetricStreamDeletedEvent, type MetricStreamEventV1 } from "./events.ts";
import {
  applyMetricStreamEventsToPostgres,
  deleteMetricStreamScopeFromPostgres,
  insertMetricStreamEventsIntoPostgres,
  type PostgresMetricStreamSinkDatabase,
} from "./postgres-sink.ts";
import type { RunMetricStreamEventConsumerOptions } from "./redpanda-consumer.ts";

const event = {
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

const dialect = new PgDialect();

function compileSqlQuery(query: Parameters<PostgresMetricStreamSinkDatabase["execute"]>[0]) {
  if (typeof query === "string") {
    throw new Error("expected SQL object");
  }
  if (!(query instanceof SQL)) {
    throw new Error("expected SQL query");
  }
  return dialect.sqlToQuery(query);
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

afterEach(() => {
  vi.doUnmock("../db/index.ts");
  vi.doUnmock("./redpanda-consumer.ts");
  vi.resetModules();
});

describe("insertMetricStreamEventsIntoPostgres", () => {
  it("upserts metric-stream events by event id for replay-safe syncs", async () => {
    const execute = vi.fn<PostgresMetricStreamSinkDatabase["execute"]>(async () => []);

    const inserted = await insertMetricStreamEventsIntoPostgres({ execute }, [event]);

    expect(inserted).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const firstCall = execute.mock.calls[0];
    if (!firstCall) {
      throw new Error("expected SQL execution");
    }
    const query = JSON.stringify(firstCall[0]);
    expect(query).toContain("INSERT INTO fitness.metric_stream");
    expect(query).toContain("ON CONFLICT (id, recorded_at) DO UPDATE");
    expect(query).toContain("scalar = EXCLUDED.scalar");
    expect(query).toContain("10000000-0000-4000-8000-000000000001");
  });

  it("renders point, vector, and metadata values when they are present", async () => {
    const execute = vi.fn<PostgresMetricStreamSinkDatabase["execute"]>(async () => []);

    await insertMetricStreamEventsIntoPostgres({ execute }, [
      {
        ...event,
        id: "10000000-0000-4000-8000-000000000002",
        vector: [1, 2, 3],
        point: "SRID=4326;POINT(-122.4 37.8)",
        metadata: { source: "test" },
      },
    ]);

    const firstCall = execute.mock.calls[0];
    if (!firstCall) {
      throw new Error("expected SQL execution");
    }
    const compiledQuery = compileSqlQuery(firstCall[0]);
    expect(compiledQuery.sql).toContain("ST_GeomFromEWKT");
    expect(compiledQuery.sql).toContain("ARRAY[");
    expect(compiledQuery.sql).toContain("::jsonb");
    expect(compiledQuery.params).toEqual(
      expect.arrayContaining([1, 2, 3, "SRID=4326;POINT(-122.4 37.8)", '{"source":"test"}']),
    );
    expect(compiledQuery.params).toContain('{"source":"test"}');
  });

  it("renders SQL NULL for omitted optional point, vector, and metadata values", async () => {
    const execute = vi.fn<PostgresMetricStreamSinkDatabase["execute"]>(async () => []);
    const eventWithoutOptionalValues = {
      version: 1,
      id: "10000000-0000-4000-8000-000000000003",
      recordedAt: "2026-06-06T19:00:00.000Z",
      userId: "00000000-0000-0000-0000-000000000001",
      providerId: "apple_health",
      externalId: "hk:heart-rate-1",
      deviceId: "Apple Watch",
      sourceType: "api",
      channel: "heart_rate",
      scalar: 72,
    } satisfies MetricStreamEventV1;

    await insertMetricStreamEventsIntoPostgres({ execute }, [eventWithoutOptionalValues]);

    const firstCall = execute.mock.calls[0];
    if (!firstCall) {
      throw new Error("expected SQL execution");
    }
    const compiledQuery = compileSqlQuery(firstCall[0]);
    expect(normalizeSql(compiledQuery.sql)).toBe(
      "INSERT INTO fitness.metric_stream ( id, recorded_at, user_id, provider_id, external_id, device_id, source_type, channel, activity_id, scalar, vector, point, metadata ) VALUES ( $1::uuid, $2::timestamptz, $3::uuid, $4, $5, $6, $7, $8, NULL, $9, NULL, NULL, NULL ) ON CONFLICT (id, recorded_at) DO UPDATE SET scalar = EXCLUDED.scalar, vector = EXCLUDED.vector, point = EXCLUDED.point, metadata = EXCLUDED.metadata, device_id = EXCLUDED.device_id, source_type = EXCLUDED.source_type, activity_id = EXCLUDED.activity_id",
    );
    expect(compiledQuery.params).not.toContain(undefined);
  });

  it("renders SQL NULL for explicit null point, vector, and metadata values", async () => {
    const execute = vi.fn<PostgresMetricStreamSinkDatabase["execute"]>(async () => []);

    await insertMetricStreamEventsIntoPostgres({ execute }, [event]);

    const firstCall = execute.mock.calls[0];
    if (!firstCall) {
      throw new Error("expected SQL execution");
    }
    const compiledQuery = compileSqlQuery(firstCall[0]);
    expect(normalizeSql(compiledQuery.sql)).toBe(
      "INSERT INTO fitness.metric_stream ( id, recorded_at, user_id, provider_id, external_id, device_id, source_type, channel, activity_id, scalar, vector, point, metadata ) VALUES ( $1::uuid, $2::timestamptz, $3::uuid, $4, $5, $6, $7, $8, NULL, $9, NULL, NULL, NULL ) ON CONFLICT (id, recorded_at) DO UPDATE SET scalar = EXCLUDED.scalar, vector = EXCLUDED.vector, point = EXCLUDED.point, metadata = EXCLUDED.metadata, device_id = EXCLUDED.device_id, source_type = EXCLUDED.source_type, activity_id = EXCLUDED.activity_id",
    );
    expect(compiledQuery.sql).not.toMatch(/,\s*::uuid/);
    expect(compiledQuery.sql).not.toContain("ST_GeomFromGeoJSON");
    expect(compiledQuery.sql).not.toContain("ARRAY[");
    expect(compiledQuery.sql).not.toContain("::jsonb");
  });

  it("does not execute SQL for an empty batch", async () => {
    const execute = vi.fn<PostgresMetricStreamSinkDatabase["execute"]>(async () => []);

    const inserted = await insertMetricStreamEventsIntoPostgres({ execute }, []);

    expect(inserted).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("applyMetricStreamEventsToPostgres", () => {
  it("applies scoped delete events before replacement row events", async () => {
    const execute = vi.fn<PostgresMetricStreamSinkDatabase["execute"]>(async () => []);

    const applied = await applyMetricStreamEventsToPostgres({ execute }, [
      createMetricStreamDeletedEvent({
        activityId: "20000000-0000-4000-8000-000000000001",
      }),
      { ...event, activityId: "20000000-0000-4000-8000-000000000001" },
    ]);

    expect(applied).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
    const deleteCall = execute.mock.calls[0];
    if (!deleteCall) throw new Error("expected delete SQL execution");
    const deleteQuery = compileSqlQuery(deleteCall[0]);
    expect(deleteQuery.sql).toContain("DELETE FROM fitness.metric_stream");
    expect(deleteQuery.sql).toContain("activity_id");
    const insertCall = execute.mock.calls[1];
    if (!insertCall) throw new Error("expected insert SQL execution");
    expect(JSON.stringify(insertCall[0])).toContain("INSERT INTO fitness.metric_stream");
  });

  it("flushes row batches around delete events without carrying rows across scopes", async () => {
    const execute = vi.fn<PostgresMetricStreamSinkDatabase["execute"]>(async () => []);

    const applied = await applyMetricStreamEventsToPostgres({ execute }, [
      { ...event, id: "10000000-0000-4000-8000-000000000002", externalId: "row-before-delete" },
      createMetricStreamDeletedEvent({
        activityId: "20000000-0000-4000-8000-000000000001",
      }),
      { ...event, id: "10000000-0000-4000-8000-000000000003", externalId: "row-after-delete" },
    ]);

    expect(applied).toBe(2);
    expect(execute).toHaveBeenCalledTimes(3);

    const firstInsertCall = execute.mock.calls[0];
    const deleteCall = execute.mock.calls[1];
    const secondInsertCall = execute.mock.calls[2];
    if (!firstInsertCall || !deleteCall || !secondInsertCall) {
      throw new Error("expected insert, delete, insert SQL executions");
    }
    expect(compileSqlQuery(firstInsertCall[0]).params).toContain("row-before-delete");
    expect(normalizeSql(compileSqlQuery(deleteCall[0]).sql)).toBe(
      "DELETE FROM fitness.metric_stream WHERE activity_id = $1::uuid",
    );
    const secondInsertQuery = compileSqlQuery(secondInsertCall[0]);
    expect(secondInsertQuery.params).toContain("row-after-delete");
    expect(secondInsertQuery.params).not.toContain("row-before-delete");
  });
});

describe("deleteMetricStreamScopeFromPostgres", () => {
  it("renders every supported delete scope predicate", async () => {
    const execute = vi.fn<PostgresMetricStreamSinkDatabase["execute"]>(async () => []);

    await deleteMetricStreamScopeFromPostgres(
      { execute },
      {
        userId: "00000000-0000-0000-0000-000000000001",
        providerId: "apple_health",
        externalId: null,
        channel: "heart_rate",
        activityId: "20000000-0000-4000-8000-000000000001",
        recordedAtStart: "2026-06-01T00:00:00.000Z",
        recordedAtEnd: "2026-06-02T00:00:00.000Z",
      },
    );

    const firstCall = execute.mock.calls[0];
    if (!firstCall) {
      throw new Error("expected delete SQL execution");
    }
    const compiledQuery = compileSqlQuery(firstCall[0]);
    expect(normalizeSql(compiledQuery.sql)).toBe(
      "DELETE FROM fitness.metric_stream WHERE user_id = $1::uuid AND provider_id = $2 AND external_id = $3 AND channel = $4 AND activity_id = $5::uuid AND recorded_at >= $6::timestamptz AND recorded_at < $7::timestamptz",
    );
    expect(compiledQuery.params).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "apple_health",
      null,
      "heart_rate",
      "20000000-0000-4000-8000-000000000001",
      "2026-06-01T00:00:00.000Z",
      "2026-06-02T00:00:00.000Z",
    ]);
  });

  it("fails before executing SQL when a delete scope has no usable predicates", async () => {
    const execute = vi.fn<PostgresMetricStreamSinkDatabase["execute"]>(async () => []);

    await expect(
      deleteMetricStreamScopeFromPostgres({ execute }, { providerId: "" }),
    ).rejects.toThrow("Metric stream delete scope produced no Postgres conditions");

    expect(execute).not.toHaveBeenCalled();
  });
});

describe("runMetricStreamPostgresSinkFromEnv", () => {
  it("consumes Redpanda events and inserts them into Postgres", async () => {
    const db = { execute: vi.fn(async () => []) };
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

    vi.doMock("../db/index.ts", () => ({
      createDatabaseFromEnv: vi.fn(() => db),
    }));
    vi.doMock("./redpanda-consumer.ts", () => ({
      createKafkaMetricStreamConsumerFromEnv,
      runMetricStreamEventConsumer,
    }));

    const { runMetricStreamPostgresSinkFromEnv } = await import("./postgres-sink.ts");

    await runMetricStreamPostgresSinkFromEnv();

    expect(createKafkaMetricStreamConsumerFromEnv).toHaveBeenCalledWith(
      "metric-stream-postgres-sink",
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
    await options.handleEvents([event]);
    expect(db.execute).toHaveBeenCalledOnce();
  });
});
