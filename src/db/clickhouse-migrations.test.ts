import { beforeEach, describe, expect, it, vi } from "vitest";

const pgClientMocks = vi.hoisted(() => ({
  Client: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  query: vi.fn(),
}));

vi.mock("pg", () => ({
  Client: pgClientMocks.Client,
  escapeIdentifier: (value: string) => `"${value.replaceAll('"', '""')}"`,
}));

import {
  buildClickHouseMigrationStatements,
  runClickHouseMigrations,
} from "./clickhouse-migrations.ts";

describe("buildClickHouseMigrationStatements", () => {
  it("keeps destructive cleanup and read-model creation in migration statements", () => {
    const sql = buildClickHouseMigrationStatements("postgres://health:fixture@db:5432/health").join(
      "\n",
    );

    expect(sql).toContain("DROP TABLE IF EXISTS fitness.metric_stream");
    expect(sql).toContain("DROP TABLE IF EXISTS fitness.deduped_sensor");
    expect(sql).toContain("DROP TABLE IF EXISTS analytics.deduped_sensor");
    expect(sql).toContain("DROP DATABASE IF EXISTS postgres_fitness SYNC");
    expect(sql.match(/DROP DATABASE IF EXISTS postgres_fitness SYNC/g)).toHaveLength(1);
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.metric_stream");
    expect(sql.match(/CREATE TABLE IF NOT EXISTS postgres_fitness.metric_stream/g)).toHaveLength(2);
    expect(sql).toContain("ENGINE = MergeTree");
    expect(sql).not.toContain("ENGINE = MaterializedPostgreSQL");
    expect(sql).not.toContain("materialized_postgresql_tables_list = 'metric_stream'");
    expect(sql).toContain(
      "ENGINE = PostgreSQL('db:5432', 'health', 'health', 'fixture', 'clickhouse')",
    );
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor");
    expect(
      sql.match(/CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor/g),
    ).toHaveLength(2);
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_summary");
    expect(
      sql.match(/CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_summary/g),
    ).toHaveLength(2);
  });
});

describe("runClickHouseMigrations", () => {
  beforeEach(() => {
    pgClientMocks.Client.mockReset().mockImplementation(() => pgClientMocks);
    pgClientMocks.connect.mockReset().mockResolvedValue(undefined);
    pgClientMocks.end.mockReset().mockResolvedValue(undefined);
    pgClientMocks.query.mockReset().mockResolvedValue({
      rows: [],
    });
  });

  it("runs pending ClickHouse migrations once and records them", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          queryText.includes("system.tables")
            ? [{ table_count: 1 }]
            : queryText.includes("system.databases")
              ? [{ engine: "Atomic" }]
              : [{ migration_count: 0 }],
        ),
    }));
    const client = { command, query };

    const count = await runClickHouseMigrations(client, "postgres://health:fixture@db:5432/health");

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
    expect(command).not.toHaveBeenCalledWith(
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
    const systemTableQueries = query.mock.calls.filter(([options]) =>
      String(options.query).includes("system.tables"),
    );
    expect(systemTableQueries).toHaveLength(7);
    expect(command).toHaveBeenCalledWith({
      query: expect.stringContaining(
        "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor",
      ),
      clickhouse_settings: {
        allow_experimental_refreshable_materialized_view: 1,
      },
    });
    expect(command).toHaveBeenCalledWith({
      query: expect.stringContaining(
        "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_summary",
      ),
      clickhouse_settings: {
        allow_experimental_refreshable_materialized_view: 1,
      },
    });
  });

  it("fails when the ClickHouse client cannot query migration state", async () => {
    await expect(
      runClickHouseMigrations(
        { command: vi.fn().mockResolvedValue(undefined) },
        "postgres://health:fixture@db:5432/health",
      ),
    ).rejects.toThrow("ClickHouse migrations require a query-capable client");
  });

  it("backfills native metric stream in occupied Timescale chunk ranges", async () => {
    pgClientMocks.query.mockImplementation((queryText: string) => {
      if (queryText.includes("timescaledb_information.chunks")) {
        return Promise.resolve({
          rows: [
            {
              chunk_schema: "_timescaledb_internal",
              chunk_name: "_hyper_1_1_chunk",
            },
            {
              chunk_schema: "_timescaledb_internal",
              chunk_name: "_hyper_1_2_chunk",
            },
          ],
        });
      }
      return Promise.resolve({
        rows: [
          queryText.includes("_hyper_1_1_chunk")
            ? {
                lower_bound: "2026-04-22 00:00:00+00",
                upper_bound: "2026-04-22 01:00:00.000001+00",
              }
            : {
                lower_bound: "2026-04-22 01:00:00+00",
                upper_bound: "2026-04-22 02:00:00.000001+00",
              },
        ],
      });
    });
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          queryText.includes("system.tables")
            ? [{ table_count: 1 }]
            : queryText.includes("system.databases")
              ? [{ engine: "Atomic" }]
              : queryText.includes("0006_backfill_native_metric_stream")
                ? [{ migration_count: 0 }]
                : queryText.includes("metric_stream_backfill_chunks")
                  ? [{ chunk_count: 0 }]
                  : [{ migration_count: 1 }],
        ),
    }));
    const client = { command, query };

    const count = await runClickHouseMigrations(client, "postgres://health:fixture@db:5432/health");

    expect(count).toBe(1);
    expect(pgClientMocks.Client).toHaveBeenCalledWith({
      connectionString: "postgres://health:fixture@db:5432/health",
    });
    expect(pgClientMocks.connect).toHaveBeenCalledTimes(1);
    expect(pgClientMocks.end).toHaveBeenCalledTimes(1);
    expect(String(pgClientMocks.query.mock.calls[0]?.[0])).toContain(
      "timescaledb_information.chunks",
    );
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
      "metric_stream.recorded_at < toDateTime64('2026-04-22 01:00:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[1]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2026-04-22 01:00:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[1]).toContain(
      "metric_stream.recorded_at < toDateTime64('2026-04-22 02:00:00.000', 6, 'UTC')",
    );
    const completedChunkStatements = command.mock.calls
      .map(([options]) => String(options.query))
      .filter((queryText) =>
        queryText.includes("INSERT INTO analytics.metric_stream_backfill_chunks"),
      );
    expect(completedChunkStatements).toHaveLength(2);
    expect(completedChunkStatements[0]).toContain(
      "VALUES (toDateTime64('2026-04-22 00:00:00.000', 6, 'UTC'), toDateTime64('2026-04-22 01:00:00.000', 6, 'UTC'))",
    );
    expect(completedChunkStatements[1]).toContain(
      "VALUES (toDateTime64('2026-04-22 01:00:00.000', 6, 'UTC'), toDateTime64('2026-04-22 02:00:00.000', 6, 'UTC'))",
    );
  });

  it("skips Timescale metric stream chunks with no rows", async () => {
    pgClientMocks.query.mockImplementation((queryText: string) => {
      if (queryText.includes("timescaledb_information.chunks")) {
        return Promise.resolve({
          rows: [
            {
              chunk_schema: "_timescaledb_internal",
              chunk_name: "_hyper_1_empty_chunk",
            },
            {
              chunk_schema: "_timescaledb_internal",
              chunk_name: "_hyper_1_populated_chunk",
            },
          ],
        });
      }
      return Promise.resolve({
        rows: [
          queryText.includes("_hyper_1_empty_chunk")
            ? {
                lower_bound: null,
                upper_bound: null,
              }
            : {
                lower_bound: "2026-04-22 03:15:00+00",
                upper_bound: "2026-04-22 03:45:00.000001+00",
              },
        ],
      });
    });
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          queryText.includes("system.tables")
            ? [{ table_count: 1 }]
            : queryText.includes("system.databases")
              ? [{ engine: "Atomic" }]
              : queryText.includes("0006_backfill_native_metric_stream")
                ? [{ migration_count: 0 }]
                : queryText.includes("metric_stream_backfill_chunks")
                  ? [{ chunk_count: 0 }]
                  : [{ migration_count: 1 }],
        ),
    }));

    await runClickHouseMigrations({ command, query }, "postgres://health:fixture@db:5432/health");

    const backfillStatements = command.mock.calls
      .map(([options]) => String(options.query))
      .filter((queryText) => queryText.includes("INSERT INTO postgres_fitness.metric_stream"));
    expect(backfillStatements).toHaveLength(1);
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2026-04-22 03:15:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at < toDateTime64('2026-04-22 03:45:00.000', 6, 'UTC')",
    );
  });

  it("splits large Timescale metric stream chunks into bounded backfill windows", async () => {
    pgClientMocks.query.mockImplementation((queryText: string) => {
      if (queryText.includes("timescaledb_information.chunks")) {
        return Promise.resolve({
          rows: [
            {
              chunk_schema: "_timescaledb_internal",
              chunk_name: "_hyper_1_1_chunk",
            },
          ],
        });
      }
      return Promise.resolve({
        rows: [
          {
            lower_bound: "2026-04-22T00:00:00.000000Z",
            upper_bound: "2026-04-22T02:30:00.000000Z",
          },
        ],
      });
    });
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          queryText.includes("system.tables")
            ? [{ table_count: 1 }]
            : queryText.includes("system.databases")
              ? [{ engine: "Atomic" }]
              : queryText.includes("0006_backfill_native_metric_stream")
                ? [{ migration_count: 0 }]
                : queryText.includes("metric_stream_backfill_chunks")
                  ? [{ chunk_count: 0 }]
                  : [{ migration_count: 1 }],
        ),
    }));

    await runClickHouseMigrations({ command, query }, "postgres://health:fixture@db:5432/health");

    const backfillStatements = command.mock.calls
      .map(([options]) => String(options.query))
      .filter((queryText) => queryText.includes("INSERT INTO postgres_fitness.metric_stream"));
    expect(backfillStatements).toHaveLength(1);
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2026-04-22 00:00:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at < toDateTime64('2026-04-22 02:30:00.000', 6, 'UTC')",
    );
  });

  it("preserves native metric stream backfill progress when retrying the migration", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          queryText.includes("system.tables")
            ? [{ table_count: 1 }]
            : queryText.includes("system.databases")
              ? [{ engine: "Atomic" }]
              : queryText.includes("0006_backfill_native_metric_stream")
                ? [{ migration_count: 0 }]
                : [{ migration_count: 1 }],
        ),
    }));

    await runClickHouseMigrations({ command, query }, "postgres://health:fixture@db:5432/health");

    expect(command).not.toHaveBeenCalledWith(
      expect.objectContaining({
        query: "DROP DATABASE IF EXISTS postgres_fitness SYNC",
      }),
    );
    expect(command).not.toHaveBeenCalledWith(
      expect.objectContaining({
        query: "DROP TABLE IF EXISTS analytics.metric_stream_backfill_chunks",
      }),
    );
  });

  it("drops non-native postgres_fitness databases before replacing metric stream", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          queryText.includes("system.tables")
            ? [{ table_count: 1 }]
            : queryText.includes("system.databases")
              ? [{ engine: "PostgreSQL" }]
              : queryText.includes("0006_backfill_native_metric_stream")
                ? [{ migration_count: 0 }]
                : [{ migration_count: 1 }],
        ),
    }));

    await runClickHouseMigrations({ command, query }, "postgres://health:fixture@db:5432/health");

    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "DROP DATABASE IF EXISTS postgres_fitness SYNC",
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "DROP TABLE IF EXISTS analytics.metric_stream_backfill_chunks",
      }),
    );
  });

  it("splits long native metric stream chunks into six-hour backfill ranges", async () => {
    pgClientMocks.query.mockImplementation((queryText: string) => {
      if (queryText.includes("timescaledb_information.chunks")) {
        return Promise.resolve({
          rows: [
            {
              chunk_schema: "_timescaledb_internal",
              chunk_name: "_hyper_1_1_chunk",
            },
          ],
        });
      }
      return Promise.resolve({
        rows: [
          {
            lower_bound: "2021-04-29 00:00:00+00",
            upper_bound: "2021-04-30 00:00:00+00",
          },
        ],
      });
    });
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          queryText.includes("system.tables")
            ? [{ table_count: 1 }]
            : queryText.includes("system.databases")
              ? [{ engine: "Atomic" }]
              : queryText.includes("0006_backfill_native_metric_stream")
                ? [{ migration_count: 0 }]
                : queryText.includes("metric_stream_backfill_chunks")
                  ? [{ chunk_count: 0 }]
                  : [{ migration_count: 1 }],
        ),
    }));

    await runClickHouseMigrations({ command, query }, "postgres://health:fixture@db:5432/health");

    const backfillStatements = command.mock.calls
      .map(([options]) => String(options.query))
      .filter((queryText) => queryText.includes("INSERT INTO postgres_fitness.metric_stream"));
    expect(backfillStatements).toHaveLength(4);
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2021-04-29 00:00:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at < toDateTime64('2021-04-29 06:00:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[3]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2021-04-29 18:00:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[3]).toContain(
      "metric_stream.recorded_at < toDateTime64('2021-04-30 00:00:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[0]).toContain("LEFT JOIN (");
    expect(backfillStatements[0]).toContain("existing_metric_stream.id IS NULL");
  });

  it("skips native metric stream chunks already marked complete", async () => {
    pgClientMocks.query.mockImplementation((queryText: string) => {
      if (queryText.includes("timescaledb_information.chunks")) {
        return Promise.resolve({
          rows: [
            {
              chunk_schema: "_timescaledb_internal",
              chunk_name: "_hyper_1_1_chunk",
            },
            {
              chunk_schema: "_timescaledb_internal",
              chunk_name: "_hyper_1_2_chunk",
            },
          ],
        });
      }
      return Promise.resolve({
        rows: [
          queryText.includes("_hyper_1_1_chunk")
            ? {
                lower_bound: "2026-04-22 00:00:00+00",
                upper_bound: "2026-04-22 01:00:00+00",
              }
            : {
                lower_bound: "2026-04-22 01:00:00+00",
                upper_bound: "2026-04-22 02:00:00+00",
              },
        ],
      });
    });
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi.fn().mockResolvedValue(
        queryText.includes("system.tables")
          ? [{ table_count: 1 }]
          : queryText.includes("system.databases")
            ? [{ engine: "Atomic" }]
            : queryText.includes("0006_backfill_native_metric_stream")
              ? [{ migration_count: 0 }]
              : queryText.includes("metric_stream_backfill_chunks")
                ? [
                    {
                      chunk_count: queryText.includes("2026-04-22 00:00:00.000") ? 1 : 0,
                    },
                  ]
                : [{ migration_count: 1 }],
      ),
    }));

    const count = await runClickHouseMigrations(
      { command, query },
      "postgres://health:fixture@db:5432/health",
    );

    expect(count).toBe(1);
    const backfillStatements = command.mock.calls
      .map(([options]) => String(options.query))
      .filter((queryText) => queryText.includes("INSERT INTO postgres_fitness.metric_stream"));
    expect(backfillStatements).toHaveLength(1);
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2026-04-22 01:00:00.000', 6, 'UTC')",
    );
    const completionQueries = query.mock.calls
      .map(([options]) => String(options.query))
      .filter((queryText) => queryText.includes("analytics.metric_stream_backfill_chunks"));
    expect(completionQueries[0]).toContain("lower_bound <=");
    expect(completionQueries[0]).toContain("upper_bound >=");
  });

  it("does not create backfill tracking when Timescale has no metric stream chunks", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          queryText.includes("system.tables")
            ? [{ table_count: 1 }]
            : queryText.includes("system.databases")
              ? [{ engine: "Atomic" }]
              : queryText.includes("0006_backfill_native_metric_stream")
                ? [{ migration_count: 0 }]
                : [{ migration_count: 1 }],
        ),
    }));

    const count = await runClickHouseMigrations(
      { command, query },
      "postgres://health:fixture@db:5432/health",
    );

    expect(count).toBe(1);
    expect(command).not.toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining(
          "CREATE TABLE IF NOT EXISTS analytics.metric_stream_backfill_chunks",
        ),
      }),
    );
    expect(command).not.toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("INSERT INTO postgres_fitness.metric_stream"),
      }),
    );
  });

  it("rejects invalid Timescale metric stream chunk bounds", async () => {
    pgClientMocks.query.mockImplementation((queryText: string) => {
      if (queryText.includes("timescaledb_information.chunks")) {
        return Promise.resolve({
          rows: [
            {
              chunk_schema: "_timescaledb_internal",
              chunk_name: "_hyper_1_1_chunk",
            },
          ],
        });
      }
      return Promise.resolve({
        rows: [
          {
            lower_bound: "not-a-timestamp",
            upper_bound: "2026-04-22 06:00:00+00",
          },
        ],
      });
    });
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          queryText.includes("system.tables")
            ? [{ table_count: 1 }]
            : queryText.includes("system.databases")
              ? [{ engine: "Atomic" }]
              : queryText.includes("0006_backfill_native_metric_stream")
                ? [{ migration_count: 0 }]
                : [{ migration_count: 1 }],
        ),
    }));

    await expect(
      runClickHouseMigrations(
        { command: vi.fn().mockResolvedValue(undefined), query },
        "postgres://health:fixture@db:5432/health",
      ),
    ).rejects.toThrow("Invalid metric_stream chunk lower bound: not-a-timestamp");
    expect(pgClientMocks.end).toHaveBeenCalledTimes(1);
  });

  it("skips already-applied ClickHouse migrations", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue([{ migration_count: 1 }]),
    });
    const client = { command, query };

    const count = await runClickHouseMigrations(client, "postgres://health:fixture@db:5432/health");

    expect(count).toBe(0);
    expect(command).not.toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("DROP TABLE IF EXISTS fitness.metric_stream"),
      }),
    );
  });
});
