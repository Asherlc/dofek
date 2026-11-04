import { PassThrough, Readable } from "node:stream";
import { createClient } from "@clickhouse/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createClientMock = vi.mocked(createClient, { partial: true });

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
  function nativeClient() {
    return {
      command: vi.fn().mockResolvedValue({ query_id: "native" }),
      exec: vi.fn().mockResolvedValue({ stream: Readable.from([]), query_id: "input" }),
      query: vi.fn().mockResolvedValue({ json: async () => [] }),
      insert: vi.fn().mockResolvedValue({ query_id: "insert" }),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }
  beforeEach(() => {
    createClientMock.mockReturnValue(nativeClient());
  });

  it("routes input through the same official client and consumes an empty response", async () => {
    const native = nativeClient();
    const response = new PassThrough();
    native.exec.mockResolvedValue({ stream: response, query_id: "input" });
    createClientMock.mockReturnValue(native);
    const client = createClickHouseClientFromEnv({ CLICKHOUSE_URL: "http://clickhouse:8123" });
    const values = Readable.from([]);
    const pending = client.command({
      query: "INSERT INTO example SELECT * FROM input('n UInt8') FORMAT JSONEachRow",
      query_id: "owned",
      values,
      clickhouse_settings: {
        http_wait_end_of_query: 0,
        async_insert: 1,
        send_progress_in_http_headers: 1,
      },
    });
    let completed = false;
    void pending.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    response.end();
    expect(await pending).toBeUndefined();
    expect(native.command).not.toHaveBeenCalled();
    expect(native.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        values,
        query_id: "owned",
        clickhouse_settings: {
          http_wait_end_of_query: 1,
          async_insert: 0,
          send_progress_in_http_headers: 0,
        },
      }),
    );
  });

  it.each(["unexpected body", "stream failure", "premature close"])(
    "rejects %s without exposing body bytes",
    async (failure) => {
      const native = nativeClient();
      const response = new PassThrough();
      native.exec.mockResolvedValue({ stream: response, query_id: "input" });
      createClientMock.mockReturnValue(native);
      const client = createClickHouseClientFromEnv({ CLICKHOUSE_URL: "http://clickhouse:8123" });
      const pending = client.command({ query: "INSERT", values: Readable.from([]) });
      const rejected = expect(pending).rejects.toThrow(
        failure === "unexpected body"
          ? "Unexpected nonempty ClickHouse input command response"
          : failure === "stream failure"
            ? "synthetic transport failure"
            : "Premature close",
      );
      await Promise.resolve();
      if (failure === "unexpected body") response.end("private synthetic response bytes");
      else
        response.destroy(
          failure === "stream failure" ? new Error("synthetic transport failure") : undefined,
        );
      await rejected;
    },
  );

  it("preserves ordinary command and bound SDK method behavior", async () => {
    const native = nativeClient();
    for (const method of ["command", "query", "insert", "close"] as const) {
      native[method].mockImplementation(function (this: unknown) {
        expect(this).toBe(native);
        return Promise.resolve(
          method === "query" ? { json: async () => [] } : { query_id: method },
        );
      });
    }
    createClientMock.mockReturnValue(native);
    const client = createClickHouseClientFromEnv({ CLICKHOUSE_URL: "http://clickhouse:8123" });
    expect(await client.command({ query: "SELECT 1" })).toEqual({ query_id: "command" });
    await client.query({ query: "SELECT 1", format: "JSONEachRow" });
    await client.insert?.({ table: "example", format: "JSONEachRow", values: [] });
    await client.close?.();
    expect(native.exec).not.toHaveBeenCalled();
  });

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
      clickhouse_settings: {
        allow_experimental_nullable_tuple_type: 1,
      },
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
      clickhouse_settings: {
        allow_experimental_nullable_tuple_type: 1,
      },
    });
  });
});

describe("buildClickHouseBootstrapStatements", () => {
  it("creates native metric stream source and ClickHouse analytics tables", () => {
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
      "clinical_record",
      "provider",
      "provider_priority",
      "device_priority",
      "sensor_provider_priority",
      "sensor_device_priority",
      "user_profile",
    ];

    expect(sql).toContain("CREATE DATABASE IF NOT EXISTS analytics");
    expect(sql).not.toContain("CREATE DATABASE IF NOT EXISTS fitness");
    expect(sql).toContain("CREATE DATABASE IF NOT EXISTS postgres_fitness");
    expect(sql).toContain("CREATE DATABASE IF NOT EXISTS ingest");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS ingest.metric_stream");
    const metricStreamDefinition = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS ingest.metric_stream"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS ingest.metric_stream_delete_acknowledgement"),
    );
    expect(sql).toContain("PROJECTION by_provider_current_state");
    expect(sql).toContain("vector Array(Float32)");
    expect(sql).toContain("ingested_at DateTime64(9) DEFAULT now()");
    expect(sql).toContain("is_deleted Int8 DEFAULT 0");
    expect(sql).toContain("version Int64 DEFAULT 0");
    expect(sql).not.toContain(
      "ALTER TABLE postgres_fitness.metric_stream ADD COLUMN IF NOT EXISTS _peerdb_synced_at",
    );
    expect(sql).toContain("point String");
    expect(sql).toContain("metadata String");
    expect(sql).not.toContain("latitude Nullable");
    expect(sql).not.toContain("longitude Nullable");
    expect(metricStreamDefinition).not.toContain("metadata Nullable");
    for (const rawDependencyTable of rawDependencyTables) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS postgres_fitness.${rawDependencyTable}`);
    }
    expect(sql).toContain("_peerdb_synced_at DateTime64(9) DEFAULT now()");
    expect(sql).toContain("_peerdb_is_deleted Int8 DEFAULT 0");
    expect(sql).toContain("_peerdb_version Int64 DEFAULT 0");
    expect(sql).toContain("ENGINE = ReplacingMergeTree(_peerdb_version)");
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS postgres_fitness.activity (
  id UUID`);
    const activityDefinition = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS postgres_fitness.activity"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS postgres_fitness.sleep_session"),
    );
    expect(activityDefinition).toContain("ORDER BY id");
    expect(activityDefinition).not.toContain("ORDER BY (user_id, started_at, id)");
    expect(sql).toContain("CREATE OR REPLACE VIEW postgres_fitness.user_profile_current");
    expect(sql).toContain("FROM postgres_fitness.user_profile FINAL");
    expect(sql).toContain("WHERE _peerdb_is_deleted = 0");
    expect(sql).toContain("FROM ingest.metric_stream FINAL");
    expect(sql).toContain("ENGINE = ReplacingMergeTree");
    expect(sql).not.toContain("ENGINE = MaterializedPostgreSQL");
    expect(sql).not.toContain("materialized_postgresql_tables_list = 'metric_stream'");
    expect(sql).not.toContain("ENGINE = PostgreSQL");
    expect(sql).not.toContain("SYSTEM REFRESH VIEW");
    expect(sql).not.toContain("SYSTEM WAIT VIEW");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.sensor_scalar_sample");
    expect(sql).not.toContain("analytics.sensor_dirty_key");
    expect(sql).not.toContain("analytics.sensor_scalar_sample_ingest");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.deduped_sensor");
    expect(sql).not.toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor");
    const dedupedSensorDefinition = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS analytics.deduped_sensor"),
      sql.indexOf("CREATE VIEW IF NOT EXISTS analytics.deduped_location"),
    );
    expect(dedupedSensorDefinition).not.toMatch(/^\s*activity_id\s/m);
    expect(sql).toContain("JSONExtract(metric_stream.point, 'coordinates', 'Array(Float64)')");
    expect(sql).toContain("parsed_points.point.2");
    expect(sql).toContain("parsed_points.point.1");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.activity_summary_rows");
    expect(sql).toContain("CREATE OR REPLACE VIEW analytics.activity_summary\nAS");
    expect(sql).toContain("FROM analytics.activity_summary_rows AS summary FINAL");
    expect(sql).not.toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_summary");
    expect(sql).not.toContain("SYSTEM REFRESH VIEW analytics.activity_summary");
    expect(sql).not.toContain("SYSTEM WAIT VIEW analytics.activity_summary");
    expect(sql).not.toContain("DROP TABLE IF EXISTS");
    expect(sql).not.toContain("DROP VIEW IF EXISTS");
    expect(sql).toContain("FROM ingest.metric_stream");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.v_activity");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.v_activity_members");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.v_sleep");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.resting_heart_rate_sleep_window");
    expect(sql).not.toContain("analytics.resting_heart_rate_dirty_key");
    expect(sql).not.toContain("SYSTEM REFRESH VIEW analytics.resting_heart_rate_sleep_window");
    expect(sql).not.toContain("SYSTEM WAIT VIEW analytics.resting_heart_rate_sleep_window");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.deduped_location");
    expect(sql).not.toContain("SYSTEM REFRESH VIEW analytics.deduped_location");
    expect(sql).not.toContain("SYSTEM WAIT VIEW analytics.deduped_location");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS analytics.body_measurement_sample");
    expect(sql).toContain(
      "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.body_measurement_sample_ingest TO analytics.body_measurement_sample",
    );
    expect(sql).toContain("FROM analytics.body_measurement_sample FINAL");
    expect(sql).not.toContain("FROM postgres_fitness.body_measurement");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.v_daily_metrics");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.provider_stats");
    expect(sql).toContain("toUInt8(0) AS is_deleted");
    expect(sql).toContain("toUInt64(toUnixTimestamp64Nano(now64(9))) AS refresh_version");
    expect(sql).toContain("now64(9) AS refreshed_at");
    expect(sql).not.toContain("SYSTEM REFRESH VIEW analytics.provider_stats");
    expect(sql).not.toContain("SYSTEM WAIT VIEW analytics.provider_stats");
    expect(sql).toContain("toUInt8(0) AS is_deleted");
    expect(sql).toContain("refresh_clock.refresh_version AS refresh_version");
    expect(sql).toContain("refresh_clock.refreshed_at AS refreshed_at");
    expect(sql).toContain("CREATE VIEW IF NOT EXISTS analytics.activity_trend_daily");
    expect(sql).not.toContain("SYSTEM REFRESH VIEW analytics.activity_trend_daily");
    expect(sql).not.toContain("SYSTEM WAIT VIEW analytics.activity_trend_daily");
    expect(sql).toContain("countIf(distinct_samples.channel = 'speed') AS speed_samples");
    expect(sql).toContain("uniqExact(activity_id) AS activity_count");
    expect(sql).toContain("FROM postgres_fitness.provider_connection FINAL");
    expect(sql).toContain("FROM postgres_fitness.food_entry FINAL");
    expect(sql).toContain("FROM postgres_fitness.health_event FINAL");
    expect(sql).toContain("FROM postgres_fitness.clinical_record FINAL");
    expect(sql).toContain("uniqExact(date) AS count");
    expect(sql).not.toContain("CAST(0, 'UInt64') AS food_entries");
    expect(sql).not.toContain("CAST(0, 'UInt64') AS health_events");
    expect(sql).not.toContain("CAST(0, 'UInt64') AS nutrition_daily");
    expect(sql).not.toContain("CAST(0, 'UInt64') AS clinical_records");
    expect(sql).not.toContain(
      "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.derived_resting_heart_rate",
    );
    expect(sql).toContain("FROM ingest.metric_stream FINAL");
    expect(sql).toContain("WHERE _peerdb_is_deleted = 0");
    expect(sql).toContain("FROM analytics.v_activity");
    expect(sql).toContain("FROM analytics.v_activity_members");
    expect(sql).not.toContain("FROM postgres_fitness_live.v_activity");
    expect(sql).not.toContain("FROM postgres_fitness_live.v_activity_members");
    expect(sql).toContain("WITH RECURSIVE");
    expect(sql).not.toContain("min(toString(connected_activity_id)) AS group_id");
    expect(sql).toContain("min(toString(connected_sleep_id)) AS group_id");
    expect(sql).not.toContain("connected_measurement_id");
    expect(sql).toContain("JOIN analytics.deduped_sensor AS");
  });
});

describe("bootstrapClickHouseFromEnv", () => {
  it("verifies migrated ClickHouse analytics tables exist without running DDL", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockImplementation(({ query: queryText }: { query: string }) => ({
      json: vi
        .fn()
        .mockResolvedValue(
          queryText.includes("system.tables") ? [{ table_count: 1 }] : [{ column_count: 1 }],
        ),
    }));
    const client = { command, query };

    await bootstrapClickHouseFromEnv(client);

    expect(command).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith({
      query:
        "SELECT count() AS table_count FROM system.tables WHERE database = 'ingest' AND name = 'metric_stream'",
      format: "JSONEachRow",
    });
    expect(query).toHaveBeenCalledWith({
      query:
        "SELECT count() AS table_count FROM system.tables WHERE database = 'analytics' AND name = 'deduped_sensor'",
      format: "JSONEachRow",
    });
    expect(query).toHaveBeenCalledWith({
      query:
        "SELECT count() AS table_count FROM system.tables WHERE database = 'analytics' AND name = 'deduped_activities'",
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
      query:
        "SELECT count() AS column_count FROM system.columns WHERE database = 'ingest' AND table = 'metric_stream'",
      format: "JSONEachRow",
    });
    expect(query).toHaveBeenCalledWith({
      query:
        "SELECT count() AS column_count FROM system.columns WHERE database = 'analytics' AND table = 'deduped_sensor'",
      format: "JSONEachRow",
    });
    expect(query).toHaveBeenCalledWith({
      query:
        "SELECT count() AS column_count FROM system.columns WHERE database = 'analytics' AND table = 'deduped_activities'",
      format: "JSONEachRow",
    });
    expect(query).toHaveBeenCalledWith({
      query:
        "SELECT count() AS column_count FROM system.columns WHERE database = 'analytics' AND table = 'activity_summary'",
      format: "JSONEachRow",
    });
    expect(query).toHaveBeenCalledWith({
      query:
        "SELECT count() AS column_count FROM system.columns WHERE database = 'analytics' AND table = 'activity_trend_daily'",
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

  it("retries transient ClickHouse connection refusals during startup", async () => {
    vi.useFakeTimers();
    try {
      let queryCount = 0;
      const query = vi.fn().mockImplementation(() => {
        queryCount += 1;
        if (queryCount < 3) {
          throw new Error("connect ECONNREFUSED 10.0.1.8:8123");
        }
        return {
          json: vi.fn().mockResolvedValue([{ table_count: 1 }]),
        };
      });

      const result = waitForClickHouseTable(
        { command: vi.fn().mockResolvedValue(undefined), query },
        "postgres_fitness",
        "metric_stream",
      );

      await vi.advanceTimersByTimeAsync(3_000);

      await expect(result).resolves.toBeUndefined();
      expect(query).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries transient ClickHouse request timeouts during startup", async () => {
    vi.useFakeTimers();
    try {
      let queryCount = 0;
      const query = vi.fn().mockImplementation(() => {
        queryCount += 1;
        if (queryCount < 3) {
          throw new Error("Timeout error.");
        }
        return {
          json: vi.fn().mockResolvedValue([{ table_count: 1 }]),
        };
      });

      const result = waitForClickHouseTable(
        { command: vi.fn().mockResolvedValue(undefined), query },
        "postgres_fitness",
        "metric_stream",
      );

      await vi.advanceTimersByTimeAsync(3_000);

      await expect(result).resolves.toBeUndefined();
      expect(query).toHaveBeenCalledTimes(3);
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
