import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { MetricStreamEventPublisher } from "../src/metric-stream/redpanda-producer.ts";
import {
  backfillMetricStreamToRedpanda,
  buildMetricStreamBackfillQuery,
  type PostgresMetricStreamBackfillDatabase,
  parseMetricStreamBackfillOptions,
} from "./backfill-metric-stream-to-redpanda.ts";

const dialect = new PgDialect();

function compileSqlQuery(query: Parameters<PostgresMetricStreamBackfillDatabase["execute"]>[0]) {
  if (typeof query === "string") {
    throw new Error("expected SQL object");
  }
  if (!(query instanceof SQL)) {
    throw new Error("expected SQL query");
  }
  return dialect.sqlToQuery(query);
}

describe("parseMetricStreamBackfillOptions", () => {
  it("requires a bounded start and end range", () => {
    expect(() => parseMetricStreamBackfillOptions([])).toThrow("--start is required");
    expect(() => parseMetricStreamBackfillOptions(["--start", "2026-06-06T00:00:00Z"])).toThrow(
      "--end is required",
    );
  });

  it("rejects an unbounded or backwards range", () => {
    expect(() =>
      parseMetricStreamBackfillOptions([
        "--start",
        "2026-06-07T00:00:00Z",
        "--end",
        "2026-06-06T00:00:00Z",
      ]),
    ).toThrow("--start must be before --end");
  });
});

describe("buildMetricStreamBackfillQuery", () => {
  it("selects the complete event shape with keyset pagination and no offset", () => {
    const query = buildMetricStreamBackfillQuery({
      batchSize: 500,
      cursor: {
        id: "10000000-0000-4000-8000-000000000001",
        recordedAt: new Date("2026-06-06T01:00:00.000Z"),
      },
      end: new Date("2026-06-07T00:00:00.000Z"),
      start: new Date("2026-06-06T00:00:00.000Z"),
    });

    const compiledQuery = compileSqlQuery(query);

    expect(compiledQuery.sql).toContain("ST_AsEWKT(point) AS point");
    expect(compiledQuery.sql).toContain("FROM fitness.metric_stream");
    expect(compiledQuery.sql).toContain("(recorded_at, id) >");
    expect(compiledQuery.sql).toContain("ORDER BY recorded_at ASC, id ASC");
    expect(compiledQuery.sql).toContain("LIMIT");
    expect(compiledQuery.sql.toLowerCase()).not.toContain("offset");
  });
});

describe("backfillMetricStreamToRedpanda", () => {
  it("publishes historical rows with the original Postgres ids and resumes by cursor", async () => {
    const databaseRows = [
      {
        id: "10000000-0000-4000-8000-000000000001",
        recorded_at: new Date("2026-06-06T12:00:00.000Z"),
        user_id: "00000000-0000-0000-0000-000000000001",
        provider_id: "apple_health",
        external_id: "hk:heart-rate-1",
        device_id: "Apple Watch",
        source_type: "api",
        channel: "heart_rate",
        activity_id: null,
        scalar: 72,
        vector: null,
        point: "SRID=4326;POINT(-122.4 37.8)",
        metadata: { source: "fixture" },
      },
    ];
    const execute = vi
      .fn<PostgresMetricStreamBackfillDatabase["execute"]>()
      .mockResolvedValueOnce(databaseRows)
      .mockResolvedValueOnce([]);
    const publishRows = vi.fn<MetricStreamEventPublisher["publishRows"]>(async (rows) =>
      rows.map((row) => ({
        version: 1,
        id: row.id ?? "missing-id",
        recordedAt: new Date(row.recordedAt).toISOString(),
        userId: row.userId,
        providerId: row.providerId,
        externalId: row.externalId ?? null,
        deviceId: row.deviceId ?? null,
        sourceType: row.sourceType,
        channel: row.channel,
        activityId: row.activityId ?? null,
        scalar: row.scalar ?? null,
        vector: row.vector ?? null,
        point: row.point ?? null,
        metadata: row.metadata ?? null,
      })),
    );

    const result = await backfillMetricStreamToRedpanda({
      batchSize: 1,
      db: { execute },
      end: new Date("2026-06-07T00:00:00.000Z"),
      publisher: { publishRows },
      start: new Date("2026-06-06T00:00:00.000Z"),
    });

    expect(result).toEqual({
      batches: 1,
      published: 1,
      scanned: 1,
      lastCursor: {
        id: "10000000-0000-4000-8000-000000000001",
        recordedAt: "2026-06-06T12:00:00.000Z",
      },
    });
    expect(publishRows).toHaveBeenCalledWith([
      {
        id: "10000000-0000-4000-8000-000000000001",
        recordedAt: "2026-06-06T12:00:00.000Z",
        userId: "00000000-0000-0000-0000-000000000001",
        providerId: "apple_health",
        externalId: "hk:heart-rate-1",
        deviceId: "Apple Watch",
        sourceType: "api",
        channel: "heart_rate",
        activityId: null,
        scalar: 72,
        vector: null,
        point: "SRID=4326;POINT(-122.4 37.8)",
        metadata: { source: "fixture" },
      },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
