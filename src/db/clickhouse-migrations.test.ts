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
    expect(sql.match(/CREATE TABLE IF NOT EXISTS postgres_fitness.metric_stream/g)).toHaveLength(4);
    expect(sql).toContain("ENGINE = ReplacingMergeTree(_peerdb_version)");
    expect(sql).toContain("FROM postgres_fitness.metric_stream FINAL");
    expect(sql).toContain("WHERE _peerdb_is_deleted = 0");
    expect(sql).toContain("ENGINE = MergeTree");
    expect(sql).not.toContain("ENGINE = MaterializedPostgreSQL");
    expect(sql).not.toContain("materialized_postgresql_tables_list = 'metric_stream'");
    expect(sql).not.toContain("ENGINE = PostgreSQL");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_location");
    expect(
      sql.match(/CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor/g),
    ).toHaveLength(4);
    expect(sql).toContain("standalone_samples AS");
    expect(sql).toContain("CAST(NULL, 'Nullable(UUID)') AS activity_id");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_summary");
    expect(
      sql.match(/CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_summary/g),
    ).toHaveLength(4);
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_trend_daily");
    expect(sql).toContain("DROP TABLE IF EXISTS analytics.activity_trend_daily");
    expect(sql).toContain("SYSTEM REFRESH VIEW analytics.activity_trend_daily");
  });

  it("creates remaining analytics read models in ClickHouse", () => {
    const sql = buildClickHouseMigrationStatements("postgres://health:fixture@db:5432/health").join(
      "\n",
    );

    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_activity");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_activity_members");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_sleep");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_body_measurement");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_daily_metrics");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.provider_stats");
    expect(sql).toContain("FROM postgres_fitness.provider FINAL");
    expect(sql).toContain("FROM postgres_fitness.food_entry FINAL");
    expect(sql).toContain("FROM postgres_fitness.health_event FINAL");
    expect(sql).toContain("FROM postgres_fitness.lab_panel FINAL");
    expect(sql).toContain("FROM postgres_fitness.lab_result FINAL");
    expect(sql).toContain("FROM postgres_fitness.journal_entry FINAL");
    expect(sql).toContain("uniqExact(date) AS count");
    expect(sql).not.toContain("CAST(0, 'UInt64') AS food_entries");
    expect(sql).not.toContain("CAST(0, 'UInt64') AS health_events");
    expect(sql).not.toContain("CAST(0, 'UInt64') AS nutrition_daily");
    expect(sql).not.toContain("CAST(0, 'UInt64') AS lab_panels");
    expect(sql).not.toContain("CAST(0, 'UInt64') AS lab_results");
    expect(sql).not.toContain("CAST(0, 'UInt64') AS journal_entries");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS postgres_fitness.user_profile_current");
    expect(sql).toContain("FROM postgres_fitness.user_profile FINAL");
    expect(sql).toContain("WHERE _peerdb_is_deleted = 0");
    expect(sql).not.toContain(
      "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.derived_resting_heart_rate",
    );
    expect(sql).toContain("DROP TABLE IF EXISTS analytics.derived_resting_heart_rate");
    expect(sql).not.toContain("FROM postgres_fitness_live.v_daily_metrics");
    expect(sql).not.toContain("FROM postgres_fitness_live.v_sleep");
    expect(sql).not.toContain("FROM postgres_fitness_live.v_activity");
    expect(sql).not.toContain("FROM postgres_fitness_live.v_activity_members");
    expect(sql).toContain("connected_components AS");
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
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => {
      if (queryText.includes("system.tables") && queryText.includes("engine")) {
        return { json: vi.fn().mockResolvedValue([{ engine: "ReplacingMergeTree" }]) };
      }
      if (queryText.includes("system.tables")) {
        return { json: vi.fn().mockResolvedValue([{ table_count: 1 }]) };
      }
      if (queryText.includes("system.databases")) {
        return { json: vi.fn().mockResolvedValue([{ engine: "Atomic" }]) };
      }
      return { json: vi.fn().mockResolvedValue([{ migration_count: 0 }]) };
    });
    const client = { command, query };

    const count = await runClickHouseMigrations(client, "postgres://health:fixture@db:5432/health");

    expect(count).toBe(13);
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
        query: expect.stringContaining(
          "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_trend_daily",
        ),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("countIf(channel = 'speed') AS speed_samples"),
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
    expect(systemTableQueries).toHaveLength(33);
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
    expect(backfillStatements[0]).toContain("SELECT CAST(id, 'Nullable(UUID)') AS id");
    expect(backfillStatements[0]).toContain("AND existing_metric_stream.id IS NULL");
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

  it("does not rerun metric stream repair backfill on fresh installs", async () => {
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
            lower_bound: "2026-04-22 00:00:00+00",
            upper_bound: "2026-04-22 01:00:00+00",
          },
        ],
      });
    });
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          queryText.includes("system.tables") && queryText.includes("engine")
            ? [{ engine: "ReplacingMergeTree" }]
            : queryText.includes("system.tables")
              ? [{ table_count: 1 }]
              : queryText.includes("system.databases")
                ? [{ engine: "Atomic" }]
                : queryText.includes("0006_backfill_native_metric_stream") ||
                    queryText.includes("0012_repair_metric_stream_backfill")
                  ? [{ migration_count: 0 }]
                  : queryText.includes("metric_stream_backfill_chunks")
                    ? [{ chunk_count: 0 }]
                    : [{ migration_count: 1 }],
        ),
    }));

    const count = await runClickHouseMigrations(
      { command, query },
      "postgres://health:fixture@db:5432/health",
    );

    expect(count).toBe(2);
    const backfillStatements = command.mock.calls
      .map(([options]) => String(options.query))
      .filter((queryText) => queryText.includes("INSERT INTO postgres_fitness.metric_stream"));
    expect(backfillStatements).toHaveLength(1);
    expect(command).toHaveBeenCalledWith({
      query:
        "INSERT INTO analytics.schema_migrations (id) VALUES ('0012_repair_metric_stream_backfill')",
    });
  });

  it("runs metric stream repair backfill when native backfill was applied before this run", async () => {
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
            lower_bound: "2026-04-22 00:00:00+00",
            upper_bound: "2026-04-22 01:00:00+00",
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
              : queryText.includes("0012_repair_metric_stream_backfill")
                ? [{ migration_count: 0 }]
                : queryText.includes("metric_stream_backfill_chunks")
                  ? [{ chunk_count: 0 }]
                  : [{ migration_count: 1 }],
        ),
    }));

    const count = await runClickHouseMigrations(
      { command, query },
      "postgres://health:fixture@db:5432/health",
    );

    expect(count).toBe(1);
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "DROP TABLE IF EXISTS analytics.metric_stream_backfill_chunks",
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("INSERT INTO postgres_fitness.metric_stream"),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "SYSTEM REFRESH VIEW analytics.activity_trend_daily",
      }),
    );
  });

  it("rebuilds native metric stream when applying the location point migration", async () => {
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
            lower_bound: "2026-04-22 00:00:00+00",
            upper_bound: "2026-04-22 01:00:00+00",
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
              : queryText.includes("0013_metric_stream_location_point")
                ? [{ migration_count: 0 }]
                : queryText.includes("metric_stream_backfill_chunks")
                  ? [{ chunk_count: 0 }]
                  : [{ migration_count: 1 }],
        ),
    }));

    const count = await runClickHouseMigrations(
      { command, query },
      "postgres://health:fixture@db:5432/health",
    );

    expect(count).toBe(1);
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "DROP TABLE IF EXISTS analytics.metric_stream_backfill_chunks",
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "DROP TABLE IF EXISTS postgres_fitness.metric_stream",
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("CREATE TABLE IF NOT EXISTS postgres_fitness.metric_stream"),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("INSERT INTO postgres_fitness.metric_stream"),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "SYSTEM REFRESH VIEW analytics.deduped_sensor",
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "SYSTEM REFRESH VIEW analytics.deduped_location",
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "SYSTEM REFRESH VIEW analytics.activity_summary",
      }),
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

  it("replaces a legacy MergeTree metric stream mirror before FINAL queries run", async () => {
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
            lower_bound: "2026-04-22 00:00:00+00",
            upper_bound: "2026-04-22 01:00:00+00",
          },
        ],
      });
    });
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => {
      if (queryText.includes("system.tables") && queryText.includes("engine")) {
        return { json: vi.fn().mockResolvedValue([{ engine: "MergeTree" }]) };
      }
      if (queryText.includes("system.tables")) {
        return { json: vi.fn().mockResolvedValue([{ table_count: 1 }]) };
      }
      if (queryText.includes("system.databases")) {
        return { json: vi.fn().mockResolvedValue([{ engine: "Atomic" }]) };
      }
      if (queryText.includes("0007_repair_legacy_metric_stream_engine")) {
        return { json: vi.fn().mockResolvedValue([{ migration_count: 0 }]) };
      }
      if (queryText.includes("metric_stream_backfill_chunks")) {
        return { json: vi.fn().mockResolvedValue([{ chunk_count: 0 }]) };
      }
      return { json: vi.fn().mockResolvedValue([{ migration_count: 1 }]) };
    });

    const count = await runClickHouseMigrations(
      { command, query },
      "postgres://health:fixture@db:5432/health",
    );

    expect(count).toBe(1);
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "DROP TABLE IF EXISTS analytics.metric_stream_backfill_chunks",
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "DROP TABLE IF EXISTS postgres_fitness.metric_stream",
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("CREATE TABLE IF NOT EXISTS postgres_fitness.metric_stream"),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("ENGINE = ReplacingMergeTree(_peerdb_version)"),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("INSERT INTO postgres_fitness.metric_stream"),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "SYSTEM REFRESH VIEW analytics.provider_stats",
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
