import { describe, expect, it, vi } from "vitest";
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
    expect(sql).toContain(
      "ENGINE = MaterializedPostgreSQL('db:5432', 'health', 'health', 'secret')",
    );
    expect(sql).toContain(
      "ENGINE = PostgreSQL('db:5432', 'health', 'health', 'secret', 'clickhouse')",
    );
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor");
    expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_summary");
  });
});

describe("runClickHouseMigrations", () => {
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

    expect(count).toBe(2);
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
