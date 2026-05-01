import { beforeEach, describe, expect, it, vi } from "vitest";

const pgClientMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(),
  query: vi.fn(),
}));

vi.mock("pg", () => ({
  Client: vi.fn(() => pgClientMocks),
}));

import {
  buildClickHouseMigrationStatements,
  runClickHouseMigrations,
} from "./clickhouse-migrations.ts";

describe("buildClickHouseMigrationStatements", () => {
  it("keeps destructive cleanup and read-model creation in migration statements", () => {
    const sql = buildClickHouseMigrationStatements("postgres://health:secret@db:5432/health").join(
      "\n",
    );

    expect(sql).toContain("DROP TABLE IF EXISTS fitness.metric_stream");
    expect(sql).toContain("DROP TABLE IF EXISTS fitness.deduped_sensor");
    expect(sql).toContain("DROP TABLE IF EXISTS analytics.deduped_sensor");
    expect(sql).toContain("DROP DATABASE IF EXISTS postgres_fitness SYNC");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.metric_stream");
    expect(sql).toContain("ENGINE = MergeTree");
    expect(sql).toContain("ENGINE = MaterializedPostgreSQL");
    expect(sql).toContain("materialized_postgresql_tables_list = 'metric_stream'");
    expect(sql).toContain(
      "ENGINE = PostgreSQL('db:5432', 'health', 'health', 'secret', 'clickhouse')",
    );
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_summary");
  });
});

describe("runClickHouseMigrations", () => {
  beforeEach(() => {
    pgClientMocks.connect.mockReset().mockResolvedValue(undefined);
    pgClientMocks.end.mockReset().mockResolvedValue(undefined);
    pgClientMocks.query.mockReset().mockResolvedValue({
      rows: [{ min_recorded_at: null, upper_bound: null }],
    });
  });

  it("runs pending ClickHouse migrations once and records them", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          queryText.includes("system.tables") ? [{ table_count: 1 }] : [{ migration_count: 0 }],
        ),
    }));
    const client = { command, query };

    const count = await runClickHouseMigrations(client, "postgres://health:secret@db:5432/health");

    expect(count).toBe(5);
    expect(command).toHaveBeenCalledWith({ query: "CREATE DATABASE IF NOT EXISTS fitness" });
    expect(command).toHaveBeenCalledWith({ query: "CREATE DATABASE IF NOT EXISTS analytics" });
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.schema_migrations"),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("DROP TABLE IF EXISTS fitness.metric_stream"),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "DROP DATABASE IF EXISTS postgres_fitness SYNC",
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("CREATE TABLE IF NOT EXISTS postgres_fitness.metric_stream"),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("ENGINE = MaterializedPostgreSQL"),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining(
          "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor",
        ),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("INSERT INTO analytics.schema_migrations"),
      }),
    );
  });

  it("backfills materialized metric stream in bounded recorded_at chunks", async () => {
    pgClientMocks.query.mockResolvedValue({
      rows: [
        {
          min_recorded_at: "2026-04-22 00:00:00+00",
          upper_bound: "2026-04-22 12:00:00+00",
        },
      ],
    });
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          queryText.includes("system.tables")
            ? [{ table_count: 1 }]
            : queryText.includes("0005_backfill_materialized_metric_stream")
              ? [{ migration_count: 0 }]
              : queryText.includes("metric_stream_backfill_chunks")
                ? [{ chunk_count: 0 }]
                : [{ migration_count: 1 }],
        ),
    }));
    const client = { command, query };

    const count = await runClickHouseMigrations(client, "postgres://health:secret@db:5432/health");

    expect(count).toBe(1);
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("INSERT INTO postgres_fitness.metric_stream"),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining(
          "CREATE TABLE IF NOT EXISTS analytics.metric_stream_backfill_chunks",
        ),
      }),
    );
    const backfillStatements = command.mock.calls
      .map(([options]) => String(options.query))
      .filter((queryText) => queryText.includes("INSERT INTO postgres_fitness.metric_stream"));
    expect(backfillStatements).toHaveLength(2);
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2026-04-22 00:00:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at < toDateTime64('2026-04-22 06:00:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[1]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2026-04-22 06:00:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[1]).toContain(
      "metric_stream.recorded_at < toDateTime64('2026-04-22 12:00:00.000', 6, 'UTC')",
    );
  });

  it("skips already-applied ClickHouse migrations", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ migration_count: 1 }]),
    });
    const client = { command, query };

    const count = await runClickHouseMigrations(client, "postgres://health:secret@db:5432/health");

    expect(count).toBe(0);
    expect(command).not.toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("DROP TABLE IF EXISTS fitness.metric_stream"),
      }),
    );
  });
});
