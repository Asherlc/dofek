import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  buildMetricStreamBackfillQuery,
  type PostgresMetricStreamBackfillDatabase,
  parseMetricStreamBackfillWindow,
  streamMetricStreamBackfillBatches,
} from "./postgres-backfill-source.ts";

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

describe("parseMetricStreamBackfillWindow", () => {
  it("requires a bounded start and end range", () => {
    expect(() => parseMetricStreamBackfillWindow([])).toThrow("--start is required");
    expect(() => parseMetricStreamBackfillWindow(["--start", "2026-06-06T00:00:00Z"])).toThrow(
      "--end is required",
    );
  });

  it("rejects an unbounded or backwards range", () => {
    expect(() =>
      parseMetricStreamBackfillWindow([
        "--start",
        "2026-06-07T00:00:00Z",
        "--end",
        "2026-06-06T00:00:00Z",
      ]),
    ).toThrow("--start must be before --end");
  });

  it("defaults the batch size to 5000 when --batch-size is omitted", () => {
    const window = parseMetricStreamBackfillWindow([
      "--start",
      "2026-06-06T00:00:00Z",
      "--end",
      "2026-06-07T00:00:00Z",
    ]);
    expect(window.batchSize).toBe(5000);
  });

  it("rejects timezone-less timestamps so the window is host-independent", () => {
    expect(() =>
      parseMetricStreamBackfillWindow([
        "--start",
        "2026-06-06T00:00:00",
        "--end",
        "2026-06-07T00:00:00Z",
      ]),
    ).toThrow("--start must include a timezone");
  });
});

describe("buildMetricStreamBackfillQuery", () => {
  it("selects the complete event shape with keyset pagination and no offset", () => {
    const query = buildMetricStreamBackfillQuery({
      batchSize: 500,
      cursor: {
        id: "10000000-0000-4000-8000-000000000001",
        recordedAt: "2026-06-06 01:00:00.123456+00",
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

describe("streamMetricStreamBackfillBatches", () => {
  it("parses rows into event inputs, preserves Postgres ids, and resumes by cursor", async () => {
    const databaseRows = [
      {
        id: "10000000-0000-4000-8000-000000000001",
        recorded_at: new Date("2026-06-06T12:00:00.000Z"),
        recorded_at_cursor: "2026-06-06 12:00:00.123456+00",
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

    const batches = [];
    for await (const batch of streamMetricStreamBackfillBatches(
      { execute },
      {
        batchSize: 1,
        end: new Date("2026-06-07T00:00:00.000Z"),
        start: new Date("2026-06-06T00:00:00.000Z"),
      },
    )) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(1);
    expect(batches[0]?.rows).toEqual([
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
    // The cursor carries Postgres' full-precision ::text rendering verbatim so
    // the keyset boundary stays exact (no millisecond truncation).
    expect(batches[0]?.cursor).toEqual({
      id: "10000000-0000-4000-8000-000000000001",
      recordedAt: "2026-06-06 12:00:00.123456+00",
    });
    // Stops once a page comes back empty rather than looping forever.
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
