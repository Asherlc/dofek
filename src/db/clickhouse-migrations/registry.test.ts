import { afterEach, describe, expect, it, vi } from "vitest";

describe("clickHouseMigrations", () => {
  afterEach(() => {
    vi.doUnmock("./0044_materialize_body_measurement_view.ts");
    vi.resetModules();
  });

  it("returns the ordered ClickHouse migration list", async () => {
    const { clickHouseMigrations } = await import("./registry.ts");

    const migrations = clickHouseMigrations("postgres://test");

    expect(migrations.length).toBeGreaterThan(40);
    expect(migrations.at(0)?.id).toBe("0001_clickhouse_analytics_schema_cleanup");
    const migrationIds = migrations.map((migration) => migration.id);
    expect(new Set(migrationIds).size).toBe(migrationIds.length);
    const migrationNumbers = migrationIds.map((migrationId) => Number(migrationId.slice(0, 4)));
    expect(migrationNumbers).toEqual(
      [...migrationNumbers].sort(
        (firstMigrationNumber, secondMigrationNumber) =>
          firstMigrationNumber - secondMigrationNumber,
      ),
    );
    expect(
      migrations.find((migration) => migration.id === "0047_cover_provider_generation_projection"),
    ).toMatchObject({
      statements: expect.arrayContaining([
        expect.stringContaining("DROP PROJECTION IF EXISTS by_provider_generation"),
        expect.stringContaining("ADD PROJECTION IF NOT EXISTS by_provider_generation"),
        expect.stringContaining("source_type"),
      ]),
    });
    expect(
      migrations.find((migration) => migration.id === "0048_provider_live_generation_projection"),
    ).toMatchObject({
      id: "0048_provider_live_generation_projection",
      statements: expect.arrayContaining([
        expect.stringContaining("ADD PROJECTION IF NOT EXISTS by_provider_live_generation"),
        expect.stringContaining("is_deleted"),
      ]),
    });
    expect(
      migrations.find((migration) => migration.id === "0049_daily_sleep_provenance"),
    ).toMatchObject({
      id: "0049_daily_sleep_provenance",
      statements: expect.arrayContaining([
        expect.stringContaining("source_name Nullable(String)"),
        expect.stringContaining("source_providers Array(String) DEFAULT []"),
      ]),
    });
    expect(
      migrations.find((migration) => migration.id === "0050_repair_body_measurement_sample_ingest"),
    ).toMatchObject({
      id: "0050_repair_body_measurement_sample_ingest",
      statements: expect.arrayContaining([
        "DROP VIEW IF EXISTS analytics.body_measurement_sample_ingest",
        expect.stringContaining("FROM ingest.metric_stream"),
      ]),
    });
    expect(
      migrations.find((migration) => migration.id === "0054_activity_load_lifecycle"),
    ).toMatchObject({
      id: "0054_activity_load_lifecycle",
      statements: expect.arrayContaining([
        expect.stringContaining("ALTER TABLE analytics.daily_activity_load"),
        expect.stringContaining("ALTER TABLE analytics.daily_strain"),
      ]),
    });
    expect(
      migrations.find((migration) => migration.id === "0055_provider_connection_catalog"),
    ).toMatchObject({
      id: "0055_provider_connection_catalog",
      statements: expect.arrayContaining([
        expect.stringContaining("MODIFY COLUMN user_id Nullable(UUID)"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS postgres_fitness.provider_connection"),
      ]),
    });
    expect(migrations.at(-1)).toMatchObject({
      id: "0056_migrate_body_measurement_to_dbt",
      statements: expect.arrayContaining([
        expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.body_measurement"),
        expect.stringContaining("INSERT INTO analytics.body_measurement"),
        "DROP VIEW IF EXISTS analytics.v_body_measurement",
        "DROP TABLE IF EXISTS analytics.v_body_measurement",
        expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.v_body_measurement"),
      ]),
    });
  });

  it("rejects duplicate migration ids", async () => {
    vi.doMock("./0044_materialize_body_measurement_view.ts", () => ({
      createMigration: () => ({
        id: "0043_activity_stream_lifecycle_columns",
        statements: [],
      }),
    }));
    const { clickHouseMigrations } = await import("./registry.ts");

    expect(() => clickHouseMigrations("postgres://test")).toThrow(
      "Duplicate ClickHouse migration id: 0043_activity_stream_lifecycle_columns",
    );
  });

  it("rejects migration ids without a four digit prefix", async () => {
    vi.doMock("./0044_materialize_body_measurement_view.ts", () => ({
      createMigration: () => ({
        id: "body_measurement_view",
        statements: [],
      }),
    }));
    const { clickHouseMigrations } = await import("./registry.ts");

    expect(() => clickHouseMigrations("postgres://test")).toThrow(
      "ClickHouse migration id must start with a four digit prefix: body_measurement_view",
    );
  });

  it("rejects migration ids with non-numeric four character prefixes", async () => {
    vi.doMock("./0044_materialize_body_measurement_view.ts", () => ({
      createMigration: () => ({
        id: "abcd_body_measurement_view",
        statements: [],
      }),
    }));
    const { clickHouseMigrations } = await import("./registry.ts");

    expect(() => clickHouseMigrations("postgres://test")).toThrow(
      "ClickHouse migration id must start with a four digit prefix: abcd_body_measurement_view",
    );
  });

  it("rejects migration ids with embedded numeric prefixes", async () => {
    vi.doMock("./0044_materialize_body_measurement_view.ts", () => ({
      createMigration: () => ({
        id: "x0044_body_measurement_view",
        statements: [],
      }),
    }));
    const { clickHouseMigrations } = await import("./registry.ts");

    expect(() => clickHouseMigrations("postgres://test")).toThrow(
      "ClickHouse migration id must start with a four digit prefix: x0044_body_measurement_view",
    );
  });

  it("rejects out-of-order migration ids", async () => {
    vi.doMock("./0044_materialize_body_measurement_view.ts", () => ({
      createMigration: () => ({
        id: "0042_body_measurement_view",
        statements: [],
      }),
    }));
    const { clickHouseMigrations } = await import("./registry.ts");

    expect(() => clickHouseMigrations("postgres://test")).toThrow(
      "ClickHouse migration id is out of order: 0042_body_measurement_view",
    );
  });
});
