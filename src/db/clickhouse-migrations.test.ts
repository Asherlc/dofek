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
  it("keeps destructive cleanup and analytics table creation in migration statements", () => {
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
    expect(sql).toContain("point Nullable(Point)");
    expect(sql).toContain("ENGINE = ReplacingMergeTree(_peerdb_version)");
    expect(sql).toContain("FROM postgres_fitness.metric_stream FINAL");
    expect(sql).toContain("WHERE _peerdb_is_deleted = 0");
    expect(sql).toContain("ENGINE = ReplacingMergeTree");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.sensor_scalar_sample");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.sensor_dirty_key");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.deduped_sensor");
    expect(sql).toContain("analytics.sensor_scalar_sample");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.deduped_location");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.activity_summary");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.activity_summary_centroids_next");
    expect(sql).toContain("location_centroids AS");
    expect(sql).toContain("location_centroids.centroid_lat AS centroid_lat");
    expect(sql).toContain("location_centroids.centroid_lng AS centroid_lng");
    expect(sql.match(/CREATE VIEW IF NOT EXISTS analytics\.activity_summary\b/g)).toHaveLength(5);
    expect(
      sql.match(/CREATE VIEW IF NOT EXISTS analytics.activity_summary_centroids_next/g),
    ).toHaveLength(1);
    expect(sql).toContain(
      "RENAME TABLE analytics.activity_summary TO analytics.activity_summary_before_centroids, analytics.activity_summary_centroids_next TO analytics.activity_summary",
    );
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.activity_trend_daily");
    expect(sql).toContain("DROP TABLE IF EXISTS analytics.activity_trend_daily");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.body_measurement_sample");
    expect(sql).toContain(
      "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.body_measurement_sample_ingest TO analytics.body_measurement_sample",
    );
    expect(sql).toContain("INSERT INTO analytics.body_measurement_sample");
    expect(sql).toContain("FROM analytics.body_measurement_sample FINAL");
    expect(sql).not.toContain("FROM postgres_fitness.body_measurement");
    expect(sql).toContain("body_measurement_samples AS");
    expect(sql).toContain("measurement_key AS external_id");
  });

  it("creates remaining analytics tables in ClickHouse", () => {
    const sql = buildClickHouseMigrationStatements("postgres://health:fixture@db:5432/health").join(
      "\n",
    );

    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.v_activity");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.v_activity_members");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.v_sleep");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.resting_heart_rate_sleep_window");
    expect(sql).toContain("DROP TABLE IF EXISTS analytics.resting_heart_rate_sleep_window");
    expect(sql.indexOf("CREATE TABLE IF NOT EXISTS analytics.deduped_sensor")).toBeLessThan(
      sql.indexOf("CREATE VIEW IF NOT EXISTS analytics.resting_heart_rate_sleep_window"),
    );
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.v_body_measurement");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.v_daily_metrics");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.provider_stats");
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

  it("rebuilds sensor-dependent views after the incremental deduped sensor table", async () => {
    const appliedBeforeIncrementalMigration = new Set([
      "0001_clickhouse_analytics_schema_cleanup",
      "0002_clickhouse_postgres_bridge_and_activity_read_models",
      "0004_reenable_materialized_metric_stream",
      "0005_backfill_materialized_metric_stream",
      "0006_backfill_native_metric_stream",
      "0007_remaining_postgres_views_to_clickhouse",
      "0007_repair_legacy_metric_stream_engine",
      "0008_complete_provider_stats_raw_mirrors",
      "0009_drop_derived_resting_heart_rate_read_model",
      "0010_include_standalone_deduped_sensor_samples",
      "0011_activity_trend_daily_read_model",
      "0012_repair_metric_stream_backfill",
      "0013_metric_stream_location_point",
      "0014_resting_heart_rate_sleep_window_materialized_view",
      "0015_activity_summary_centroids",
      "0016_reduce_metric_stream_refresh_load",
      "0017_body_measurement_sample_projection",
      "0018_sensor_priority_raw_tables",
    ]);
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => {
      const migrationMatch = queryText.match(/WHERE id = '([^']+)'/);
      const migrationId = migrationMatch?.[1];
      if (migrationId) {
        return {
          json: vi
            .fn()
            .mockResolvedValue([
              { migration_count: appliedBeforeIncrementalMigration.has(migrationId) ? 1 : 0 },
            ]),
        };
      }
      if (queryText.includes("system.tables")) {
        return { json: vi.fn().mockResolvedValue([{ table_count: 1 }]) };
      }
      return { json: vi.fn().mockResolvedValue([{ migration_count: 0 }]) };
    });

    await runClickHouseMigrations({ command, query }, "postgres://health:fixture@db:5432/health");

    const commandSql = command.mock.calls.map(([options]) => String(options.query));
    const incrementalDedupedSensorTableIndex = commandSql.findIndex((queryText) =>
      queryText.includes("CREATE TABLE IF NOT EXISTS analytics.deduped_sensor"),
    );
    const restingHeartRateViewIndex = commandSql.findIndex((queryText) =>
      queryText.includes("CREATE VIEW IF NOT EXISTS analytics.resting_heart_rate_sleep_window"),
    );
    const activitySummaryViewIndex = commandSql.findIndex((queryText) =>
      queryText.includes("CREATE VIEW IF NOT EXISTS analytics.activity_summary"),
    );
    const activityTrendDailyViewIndex = commandSql.findIndex((queryText) =>
      queryText.includes("CREATE VIEW IF NOT EXISTS analytics.activity_trend_daily"),
    );

    expect(incrementalDedupedSensorTableIndex).toBeGreaterThanOrEqual(0);
    expect(restingHeartRateViewIndex).toBeGreaterThan(incrementalDedupedSensorTableIndex);
    expect(activitySummaryViewIndex).toBeGreaterThan(incrementalDedupedSensorTableIndex);
    expect(activityTrendDailyViewIndex).toBeGreaterThan(incrementalDedupedSensorTableIndex);
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

    expect(count).toBe(20);
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
        query: expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.deduped_sensor"),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.activity_trend_daily"),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining(
          "countIf(distinct_samples.channel = 'speed') AS speed_samples",
        ),
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("body_measurement_samples AS"),
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
    expect(systemTableQueries.length).toBeGreaterThan(0);
    expect(command).toHaveBeenCalledWith({
      query: expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.activity_summary"),
      clickhouse_settings: {
        allow_experimental_nullable_tuple_type: 1,
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
          queryText.includes("system.columns")
            ? [{ migration_count: 5 }]
            : queryText.includes("system.tables")
              ? [{ table_count: 1 }]
              : queryText.includes("system.databases")
                ? [{ engine: "Atomic" }]
                : queryText.includes("0006_backfill_native_metric_stream")
                  ? [{ migration_count: 0 }]
                  : queryText.includes("metric_stream_backfill_chunks")
                    ? []
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
    expect(backfillStatements).toHaveLength(24);
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2026-04-22 00:00:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at < toDateTime64('2026-04-22 00:05:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[0]).toContain("SELECT CAST(id, 'Nullable(UUID)') AS id");
    expect(backfillStatements[0]).toContain("point,");
    expect(backfillStatements[0]).toContain("readWKBPoint");
    expect(backfillStatements[0]).toContain(
      "startsWith(lower(assumeNotNull(metric_stream.point)), '0101000020')",
    );
    expect(backfillStatements[0]).toContain("substring(assumeNotNull(metric_stream.point), 19)");
    expect(backfillStatements[0]).not.toContain("metric_stream.latitude");
    expect(backfillStatements[0]).not.toContain("metric_stream.longitude");
    expect(backfillStatements[0]).toContain("AND existing_metric_stream.id IS NULL");
    expect(backfillStatements[12]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2026-04-22 01:00:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[23]).toContain(
      "metric_stream.recorded_at < toDateTime64('2026-04-22 02:00:00.000', 6, 'UTC')",
    );
    const completedChunkStatements = command.mock.calls
      .map(([options]) => String(options.query))
      .filter((queryText) =>
        queryText.includes("INSERT INTO analytics.metric_stream_backfill_chunks"),
      );
    expect(completedChunkStatements).toHaveLength(24);
    expect(completedChunkStatements[0]).toContain(
      "VALUES (toDateTime64('2026-04-22 00:00:00.000', 6, 'UTC'), toDateTime64('2026-04-22 00:05:00.000', 6, 'UTC'))",
    );
    expect(completedChunkStatements[23]).toContain(
      "VALUES (toDateTime64('2026-04-22 01:55:00.000', 6, 'UTC'), toDateTime64('2026-04-22 02:00:00.000', 6, 'UTC'))",
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
                    ? []
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
    expect(backfillStatements).toHaveLength(12);
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
          queryText.includes("system.columns")
            ? [{ migration_count: 5 }]
            : queryText.includes("system.tables")
              ? [{ table_count: 1 }]
              : queryText.includes("system.databases")
                ? [{ engine: "Atomic" }]
                : queryText.includes("0012_repair_metric_stream_backfill")
                  ? [{ migration_count: 0 }]
                  : queryText.includes("metric_stream_backfill_chunks")
                    ? []
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
  });

  it("skips metric stream repair backfill when the mirror has the old schema", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          queryText.includes("system.columns")
            ? [{ migration_count: 0 }]
            : queryText.includes("system.tables")
              ? [{ table_count: 1 }]
              : queryText.includes("system.databases")
                ? [{ engine: "Atomic" }]
                : queryText.includes("0012_repair_metric_stream_backfill")
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
        query: "DROP TABLE IF EXISTS analytics.metric_stream_backfill_chunks",
      }),
    );
    expect(command).not.toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("INSERT INTO postgres_fitness.metric_stream"),
      }),
    );
    expect(command).toHaveBeenCalledWith({
      query:
        "INSERT INTO analytics.schema_migrations (id) VALUES ('0012_repair_metric_stream_backfill')",
    });
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
                  ? []
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
  });

  it("resumes location point metric stream backfill when the mirror already has the current schema", async () => {
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
            : queryText.includes("system.columns")
              ? [{ migration_count: 5 }]
              : queryText.includes("system.databases")
                ? [{ engine: "Atomic" }]
                : queryText.includes("0013_metric_stream_location_point")
                  ? [{ migration_count: 0 }]
                  : queryText.includes("metric_stream_backfill_chunks")
                    ? []
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
        query: "DROP TABLE IF EXISTS analytics.metric_stream_backfill_chunks",
      }),
    );
    expect(command).not.toHaveBeenCalledWith(
      expect.objectContaining({
        query: "DROP TABLE IF EXISTS postgres_fitness.metric_stream",
      }),
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("INSERT INTO postgres_fitness.metric_stream"),
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
                  ? []
                  : [{ migration_count: 1 }],
        ),
    }));

    await runClickHouseMigrations({ command, query }, "postgres://health:fixture@db:5432/health");

    const backfillStatements = command.mock.calls
      .map(([options]) => String(options.query))
      .filter((queryText) => queryText.includes("INSERT INTO postgres_fitness.metric_stream"));
    expect(backfillStatements).toHaveLength(6);
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2026-04-22 03:15:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at < toDateTime64('2026-04-22 03:20:00.000', 6, 'UTC')",
    );
  });

  it("splits large Timescale metric stream chunks into five-minute backfill windows", async () => {
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
                  ? []
                  : [{ migration_count: 1 }],
        ),
    }));

    await runClickHouseMigrations({ command, query }, "postgres://health:fixture@db:5432/health");

    const backfillStatements = command.mock.calls
      .map(([options]) => String(options.query))
      .filter((queryText) => queryText.includes("INSERT INTO postgres_fitness.metric_stream"));
    expect(backfillStatements).toHaveLength(30);
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2026-04-22 00:00:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at < toDateTime64('2026-04-22 00:05:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[29]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2026-04-22 02:25:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[29]).toContain(
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
        return { json: vi.fn().mockResolvedValue([]) };
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

  it("splits long native metric stream chunks into five-minute backfill ranges", async () => {
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
                  ? []
                  : [{ migration_count: 1 }],
        ),
    }));

    await runClickHouseMigrations({ command, query }, "postgres://health:fixture@db:5432/health");

    const backfillStatements = command.mock.calls
      .map(([options]) => String(options.query))
      .filter((queryText) => queryText.includes("INSERT INTO postgres_fitness.metric_stream"));
    expect(backfillStatements).toHaveLength(288);
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2021-04-29 00:00:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at < toDateTime64('2021-04-29 00:05:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[287]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2021-04-29 23:55:00.000', 6, 'UTC')",
    );
    expect(backfillStatements[287]).toContain(
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
                      lower_bound: "2026-04-22 00:00:00.000000",
                      upper_bound: "2026-04-22 01:00:00.000000",
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
    expect(backfillStatements).toHaveLength(12);
    expect(backfillStatements[0]).toContain(
      "metric_stream.recorded_at >= toDateTime64('2026-04-22 01:00:00.000', 6, 'UTC')",
    );
    const completionQueries = query.mock.calls
      .map(([options]) => String(options.query))
      .filter((queryText) => queryText.includes("analytics.metric_stream_backfill_chunks"));
    expect(completionQueries).toHaveLength(1);
    expect(completionQueries[0]).toContain("ORDER BY lower_bound ASC, upper_bound ASC");
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
