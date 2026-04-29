import { describe, expect, it, vi } from "vitest";
import {
  bootstrapClickHouseFromEnv,
  buildClickHouseBootstrapStatements,
  parsePostgresConnectionForClickHouse,
  waitForClickHouseTable,
} from "./clickhouse.ts";

describe("parsePostgresConnectionForClickHouse", () => {
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
});

describe("buildClickHouseBootstrapStatements", () => {
  it("creates native Postgres bridges and a ClickHouse deduped sensor view", () => {
    const sql = buildClickHouseBootstrapStatements("postgres://health:secret@db:5432/health").join(
      "\n",
    );

    expect(sql).toContain("CREATE DATABASE IF NOT EXISTS analytics");
    expect(sql).not.toContain("CREATE DATABASE IF NOT EXISTS fitness");
    expect(sql).toContain(
      "ENGINE = MaterializedPostgreSQL('db:5432', 'health', 'health', 'secret')",
    );
    expect(sql).toContain("materialized_postgresql_tables_list = 'metric_stream'");
    expect(sql).toContain(
      "ENGINE = PostgreSQL('db:5432', 'health', 'health', 'secret', 'fitness')",
    );
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_summary");
    expect(sql).not.toContain("DROP TABLE IF EXISTS");
    expect(sql).not.toContain("DROP VIEW IF EXISTS");
    expect(sql).toContain("REFRESH EVERY 1 MINUTE");
    expect(sql).toContain("FROM postgres_fitness.metric_stream");
    expect(sql).toContain("FROM postgres_fitness_live.v_activity");
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
});
