import { createClient } from "@clickhouse/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createClientMock = vi.mocked(createClient);

vi.mock("@clickhouse/client", () => ({
  createClient: vi.fn(),
}));

import {
  bootstrapClickHouseFromEnv,
  buildClickHouseBootstrapStatements,
  createClickHouseClientFromEnv,
  parsePostgresConnectionForClickHouse,
  waitForClickHouseTable,
} from "./clickhouse.ts";

describe("parsePostgresConnectionForClickHouse", () => {
  beforeEach(() => {
    createClientMock.mockReset();
  });

  it("rewrites local Postgres hosts to a host reachable from the ClickHouse container", () => {
    expect(
      parsePostgresConnectionForClickHouse("postgres://health:secret@localhost:5435/health"),
    ).toEqual({
      hostAndPort: "host.docker.internal:5435",
      database: "health",
      user: "health",
      password: "secret",
    });
  });

  it("throws when the DATABASE_URL does not include a database name", () => {
    expect(() => {
      parsePostgresConnectionForClickHouse("postgres://health:secret@db:5432/");
    }).toThrow("DATABASE_URL must include a database name for ClickHouse Postgres replication");
  });

  it.each([
    ["127.0.0.1", "host.docker.internal:5432"],
    ["::1", "host.docker.internal:5432"],
  ])("rewrites %s to host.docker.internal", (hostname, expectedHostAndPort) => {
    const bracketedHostname = hostname === "::1" ? `[${hostname}]` : hostname;
    expect(
      parsePostgresConnectionForClickHouse(
        `postgres://health:secret@${bracketedHostname}:5432/health`,
      ).hostAndPort,
    ).toBe(expectedHostAndPort);
  });

  it("preserves database names with embedded slashes after the leading slash", () => {
    expect(
      parsePostgresConnectionForClickHouse("postgres://health:secret@localhost:5432/health/test")
        .database,
    ).toBe("health/test");
  });
});

describe("createClickHouseClientFromEnv", () => {
  it("throws when CLICKHOUSE_URL is missing", () => {
    expect(() => {
      createClickHouseClientFromEnv({}, {});
    }).toThrow("CLICKHOUSE_URL environment variable is required");
  });

  it("returns a client with default 120s timeout when requestTimeoutMs is undefined", () => {
    createClickHouseClientFromEnv({ CLICKHOUSE_URL: "http://clickhouse:8123" });

    expect(createClientMock).toHaveBeenCalledWith({
      url: "http://clickhouse:8123",
      request_timeout: 120_000,
    });
  });

  it("passes request timeout when requestTimeoutMs is defined", () => {
    createClickHouseClientFromEnv(
      { CLICKHOUSE_URL: "http://clickhouse:8123" },
      { requestTimeoutMs: 1_000 },
    );

    expect(createClientMock).toHaveBeenCalledWith({
      url: "http://clickhouse:8123",
      request_timeout: 1_000,
    });
  });
});

describe("buildClickHouseBootstrapStatements", () => {
  it("creates native metric stream source and ClickHouse read models", () => {
    const sql = buildClickHouseBootstrapStatements("postgres://health:secret@db:5432/health").join(
      "\n",
    );
    const rawDependencyTables = [
      "activity",
      "sleep_session",
      "sleep_stage",
      "daily_metrics",
      "food_entry",
      "health_event",
      "lab_panel",
      "lab_result",
      "journal_entry",
      "provider",
      "provider_priority",
      "device_priority",
      "user_profile",
    ];

    expect(sql).toContain("CREATE DATABASE IF NOT EXISTS analytics");
    expect(sql).not.toContain("CREATE DATABASE IF NOT EXISTS fitness");
    expect(sql).toContain("CREATE DATABASE IF NOT EXISTS postgres_fitness");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.metric_stream");
    for (const rawDependencyTable of rawDependencyTables) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS postgres_fitness.${rawDependencyTable}`);
    }
    expect(sql).toContain("_peerdb_synced_at DateTime64(9) DEFAULT now()");
    expect(sql).toContain("_peerdb_is_deleted Int8 DEFAULT 0");
    expect(sql).toContain("_peerdb_version Int64 DEFAULT 0");
    expect(sql).toContain("ENGINE = ReplacingMergeTree(_peerdb_version)");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS postgres_fitness.user_profile_current");
    expect(sql).toContain("FROM postgres_fitness.user_profile FINAL");
    expect(sql).toContain("WHERE _peerdb_is_deleted = 0");
    expect(sql).toContain("FROM postgres_fitness.metric_stream FINAL");
    expect(sql).toContain("ENGINE = MergeTree");
    expect(sql).not.toContain("ENGINE = MaterializedPostgreSQL");
    expect(sql).not.toContain("materialized_postgresql_tables_list = 'metric_stream'");
    expect(sql).not.toContain("ENGINE = PostgreSQL");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_summary");
    expect(sql).not.toContain("DROP TABLE IF EXISTS");
    expect(sql).not.toContain("DROP VIEW IF EXISTS");
    expect(sql).toContain("REFRESH EVERY 1 MINUTE");
    expect(sql).toContain("FROM postgres_fitness.metric_stream");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_activity");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_activity_members");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_sleep");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_body_measurement");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.v_daily_metrics");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.provider_stats");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_trend_daily");
    expect(sql).toContain("countIf(channel = 'speed') AS speed_samples");
    expect(sql).toContain("uniqExact(activity_id) AS activity_count");
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
    expect(sql).not.toContain(
      "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.derived_resting_heart_rate",
    );
    expect(sql).toContain("FROM postgres_fitness.metric_stream FINAL");
    expect(sql).toContain("WHERE _peerdb_is_deleted = 0");
    expect(sql).toContain("FROM analytics.v_activity");
    expect(sql).toContain("FROM analytics.v_activity_members");
    expect(sql).not.toContain("FROM postgres_fitness_live.v_activity");
    expect(sql).not.toContain("FROM postgres_fitness_live.v_activity_members");
    expect(sql).toContain("WITH RECURSIVE");
    expect(sql).toContain("connected_components AS");
    expect(sql).toContain("min(toString(connected_activity_id)) AS group_id");
    expect(sql).toContain("min(toString(connected_sleep_id)) AS group_id");
    expect(sql).toContain("min(toString(connected_measurement_id)) AS group_id");
    expect(sql).toContain(
      "concat(provider_id, ':', toString(user_id), ':', toString(recorded_at), ':', ifNull(device_id, ''))",
    );
    expect(sql).not.toContain("uniqExact(ifNull(external_id, toString(id))");
    expect(sql).toContain("body_measurement_samples AS");
    expect(sql).toContain("measurement_key AS external_id");
    expect(sql).toContain("_peerdb_synced_at AS created_at");
    expect(sql).toContain("best.created_at AS created_at");
    expect(sql).toContain("GROUP BY\n    provider_id,\n    user_id,\n    measurement_key");
    expect(sql).not.toContain("ifNull(external_id, toString(id)) AS external_id");
    expect(sql).toContain("FROM analytics.deduped_sensor");
    expect(sql).toContain(
      "if(activity_bounds.activity_type IN ('indoor_cycling', 'virtual_cycling')",
    );
    expect(sql).toContain("CAST(0, 'Nullable(Float64)')");
  });
});

describe("bootstrapClickHouseFromEnv", () => {
  it("verifies migrated ClickHouse read models exist without running DDL", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          queryText.includes("system.tables") ? [{ table_count: 1 }] : [{ smoke_count: 0 }],
        ),
    }));
    const client = { command, query };

    await bootstrapClickHouseFromEnv(client);

    expect(command).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith({
      query:
        "SELECT count() AS table_count FROM system.tables WHERE database = 'postgres_fitness' AND name = 'metric_stream'",
      format: "JSONEachRow",
    });
    expect(query).toHaveBeenCalledWith({
      query:
        "SELECT count() AS table_count FROM system.tables WHERE database = 'analytics' AND name = 'deduped_sensor'",
      format: "JSONEachRow",
    });
    expect(query).toHaveBeenCalledWith({
      query:
        "SELECT count() AS table_count FROM system.tables WHERE database = 'analytics' AND name = 'activity_summary'",
      format: "JSONEachRow",
    });
    expect(query).toHaveBeenCalledWith({
      query:
        "SELECT count() AS table_count FROM system.tables WHERE database = 'analytics' AND name = 'activity_trend_daily'",
      format: "JSONEachRow",
    });
    expect(query).toHaveBeenCalledWith({
      query: "SELECT count() AS smoke_count FROM postgres_fitness.metric_stream LIMIT 1",
      format: "JSONEachRow",
    });
    expect(query).toHaveBeenCalledWith({
      query: "SELECT count() AS smoke_count FROM analytics.deduped_sensor LIMIT 1",
      format: "JSONEachRow",
    });
    expect(query).toHaveBeenCalledWith({
      query: "SELECT count() AS smoke_count FROM analytics.activity_summary LIMIT 1",
      format: "JSONEachRow",
    });
    expect(query).toHaveBeenCalledWith({
      query: "SELECT count() AS smoke_count FROM analytics.activity_trend_daily LIMIT 1",
      format: "JSONEachRow",
    });
  });

  it("propagates smoke query failures after table existence checks pass", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => {
      if (queryText.includes("system.tables")) {
        return { json: vi.fn().mockResolvedValue([{ table_count: 1 }]) };
      }
      throw new Error("bridge authentication failed");
    });

    await expect(bootstrapClickHouseFromEnv({ command, query })).rejects.toThrow(
      "bridge authentication failed",
    );
  });
});

describe("waitForClickHouseTable", () => {
  it("fails loudly when the ClickHouse client cannot query system tables", async () => {
    await expect(
      waitForClickHouseTable({ command: vi.fn().mockResolvedValue(undefined) }, "analytics", "foo"),
    ).rejects.toThrow("ClickHouse table verification requires a query-capable client");
  });

  it("waits for ClickHouse tables that appear after startup", async () => {
    vi.useFakeTimers();
    try {
      let queryCount = 0;
      const query = vi.fn().mockImplementation(() => ({
        json: vi.fn().mockResolvedValue([{ table_count: queryCount++ >= 45 ? 1 : 0 }]),
      }));

      const result = waitForClickHouseTable(
        { command: vi.fn().mockResolvedValue(undefined), query },
        "postgres_fitness",
        "metric_stream",
      );

      await vi.advanceTimersByTimeAsync(60_000);

      await expect(result).resolves.toBeUndefined();
      expect(query).toHaveBeenCalledTimes(46);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws a timeout error when the table never appears", async () => {
    vi.useFakeTimers();
    try {
      let queryCount = 0;
      let capturedError: unknown;
      const query = vi.fn().mockImplementation(() => {
        queryCount += 1;
        return {
          json: vi.fn().mockResolvedValue([{ table_count: queryCount > 180 ? 1 : 0 }]),
        };
      });

      const result = waitForClickHouseTable(
        { command: vi.fn().mockResolvedValue(undefined), query },
        "postgres_fitness",
        "metric_stream",
      ).catch((error) => {
        capturedError = error;
      });

      await vi.advanceTimersByTimeAsync(181_000);
      await Promise.resolve();
      await result;

      expect(capturedError).toBeInstanceOf(Error);
      expect(String(capturedError)).toContain(
        "Timed out waiting for ClickHouse table postgres_fitness.metric_stream",
      );
      expect(queryCount).toBe(180);
    } finally {
      vi.useRealTimers();
    }
  });
});
