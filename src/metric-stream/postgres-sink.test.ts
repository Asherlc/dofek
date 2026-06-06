import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetricStreamEventV1 } from "./events.ts";
import {
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

afterEach(() => {
  vi.doUnmock("../db/index.ts");
  vi.doUnmock("./redpanda-consumer.ts");
  vi.resetModules();
});

describe("insertMetricStreamEventsIntoPostgres", () => {
  it("upserts metric-stream events by the provider natural key for retry-safe syncs", async () => {
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
    expect(query).toContain(
      "ON CONFLICT (user_id, provider_id, external_id, channel, recorded_at) DO UPDATE",
    );
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
    } satisfies MetricStreamEventV1;

    await insertMetricStreamEventsIntoPostgres({ execute }, [eventWithoutOptionalValues]);

    const firstCall = execute.mock.calls[0];
    if (!firstCall) {
      throw new Error("expected SQL execution");
    }
    const compiledQuery = compileSqlQuery(firstCall[0]);
    expect(compiledQuery.sql).toContain("NULL");
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
    expect(compiledQuery.sql).toContain("NULL");
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
