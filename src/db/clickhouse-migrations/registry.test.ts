import { afterEach, describe, expect, it, vi } from "vitest";

describe("clickHouseMigrations", () => {
  afterEach(() => {
    vi.doUnmock("./0058_migrate_body_measurement_to_dbt.ts");
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
        expect.stringContaining("user_id Nullable(UUID)"),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS postgres_fitness.provider_connection"),
      ]),
      run: expect.any(Function),
    });
    expect(
      migrations.find((migration) => migration.id === "0056_daily_body_measurement_lifecycle"),
    ).toMatchObject({
      id: "0056_daily_body_measurement_lifecycle",
      statements: expect.arrayContaining([
        expect.stringContaining("ADD COLUMN IF NOT EXISTS is_deleted"),
        expect.stringContaining("ADD COLUMN IF NOT EXISTS source_synced_at"),
      ]),
    });
    expect(
      migrations.find((migration) => migration.id === "0057_daily_recovery_lifecycle"),
    ).toMatchObject({
      id: "0057_daily_recovery_lifecycle",
      statements: expect.arrayContaining([
        expect.stringContaining("ALTER TABLE analytics.daily_recovery_inputs"),
        expect.stringContaining("ALTER TABLE analytics.daily_recovery"),
      ]),
    });
    expect(
      migrations.find((migration) => migration.id === "0058_migrate_body_measurement_to_dbt"),
    ).toMatchObject({
      id: "0058_migrate_body_measurement_to_dbt",
      statements: expect.arrayContaining([
        expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.body_measurement"),
        expect.stringContaining("INSERT INTO analytics.body_measurement"),
        "DROP VIEW IF EXISTS analytics.v_body_measurement",
        "DROP TABLE IF EXISTS analytics.v_body_measurement",
        expect.stringContaining("CREATE VIEW IF NOT EXISTS analytics.v_body_measurement"),
      ]),
    });
    expect(
      migrations.find((migration) => migration.id === "0059_provider_change_state"),
    ).toMatchObject({
      id: "0059_provider_change_state",
      statements: expect.arrayContaining([
        expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.provider_change_state"),
        expect.stringContaining(
          "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.provider_change_from_provider_connection",
        ),
        expect.stringContaining("FROM ingest.metric_stream"),
      ]),
    });
    expect(
      migrations.find((migration) => migration.id === "0060_heart_rate_day_change"),
    ).toMatchObject({
      id: "0060_heart_rate_day_change",
      statements: expect.arrayContaining([
        expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.heart_rate_day_change"),
        expect.stringContaining(
          "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.heart_rate_day_change_ingest",
        ),
        expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.sleep_heart_rate_window"),
      ]),
    });
    expect(
      migrations.find((migration) => migration.id === "0061_provider_current_state_projection"),
    ).toMatchObject({
      id: "0061_provider_current_state_projection",
      statements: expect.arrayContaining([
        expect.stringContaining("ADD PROJECTION IF NOT EXISTS by_provider_current_state"),
        expect.stringContaining("argMax(is_deleted, tuple(version, ingested_at)) AS is_deleted"),
        expect.stringContaining("GROUP BY user_id, provider_id, id"),
      ]),
    });
    expect(
      migrations.find((migration) => migration.id === "0062_daily_recovery_baseline_context"),
    ).toMatchObject({
      id: "0062_daily_recovery_baseline_context",
      statements: expect.arrayContaining([
        expect.stringContaining("hrv_baseline_sample_count"),
        expect.stringContaining("efficiency_mean_previous_28d"),
      ]),
    });
    expect(
      migrations.find((migration) => migration.id === "0063_record_local_time_context"),
    ).toMatchObject({
      id: "0063_record_local_time_context",
      statements: expect.arrayContaining([
        expect.stringContaining("start_utc_offset_minutes"),
        expect.stringContaining("local_time_source"),
      ]),
    });
    expect(
      migrations.find((migration) => migration.id === "0064_activity_summary_freshness"),
    ).toMatchObject({
      id: "0064_activity_summary_freshness",
      statements: [
        "DROP VIEW IF EXISTS analytics.activity_summary",
        expect.stringContaining("climbing_seconds,\n  refreshed_at"),
      ],
    });
    expect(
      migrations.find((migration) => migration.id === "0065_sleep_staging_available")?.id,
    ).toBe("0065_sleep_staging_available");
    expect(
      migrations.find((migration) => migration.id === "0066_daily_sleep_overlap_evidence"),
    ).toMatchObject({
      id: "0066_daily_sleep_overlap_evidence",
      statements: expect.arrayContaining([
        expect.stringContaining("selected_session_id Nullable(UUID)"),
        expect.stringContaining("overlapping_sessions Array(Tuple("),
      ]),
    });
    expect(
      migrations.find((migration) => migration.id === "0067_repair_local_time_column_order"),
    ).toMatchObject({
      id: "0067_repair_local_time_column_order",
      statements: expect.arrayContaining([
        expect.stringContaining(
          "MODIFY COLUMN start_utc_offset_minutes Nullable(Int16) AFTER timezone",
        ),
        expect.stringContaining(
          "MODIFY COLUMN timezone Nullable(String) AFTER overlapping_sessions",
        ),
      ]),
      run: expect.any(Function),
    });
    expect(
      migrations.find((migration) => migration.id === "0068_provider_metric_stream_daily_counts"),
    ).toMatchObject({
      id: "0068_provider_metric_stream_daily_counts",
      statements: expect.arrayContaining([
        expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.metric_stream_day_change"),
        expect.stringContaining("ORDER BY (user_id, provider_id, recorded_date)"),
        expect.stringContaining(
          "CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.metric_stream_day_change_ingest",
        ),
        expect.stringContaining("FROM ingest.metric_stream"),
        expect.stringContaining("toDate(recorded_at) AS recorded_date"),
        expect.stringContaining(
          "ADD PROJECTION IF NOT EXISTS by_provider_current_state_recorded_at",
        ),
      ]),
    });
    expect(
      migrations.find(
        (migration) => migration.id === "0073_activity_sensor_summary_source_version",
      ),
    ).toMatchObject({
      statements: expect.arrayContaining([
        expect.stringContaining("source_refresh_version UInt64 DEFAULT 0"),
        expect.stringContaining("by_activity_source_refresh_version"),
      ]),
    });
    expect(
      migrations.find((migration) => migration.id === "0069_canonical_activity_types"),
    ).toMatchObject({
      id: "0069_canonical_activity_types",
      statements: expect.arrayContaining([
        expect.stringContaining(
          "ALTER TABLE postgres_fitness.activity RENAME COLUMN activity_type TO canonical_type",
        ),
        expect.stringContaining(
          "ALTER TABLE analytics.activity_summary_rows RENAME COLUMN activity_type TO canonical_type",
        ),
      ]),
      run: expect.any(Function),
    });
    expect(
      migrations.find((migration) => migration.id === "0070_account_erasure_fence"),
    ).toMatchObject({
      id: "0070_account_erasure_fence",
      statements: [
        expect.stringContaining("CREATE TABLE IF NOT EXISTS ingest.account_erasure_fence"),
        expect.stringContaining(
          "CREATE TABLE IF NOT EXISTS ingest.account_erasure_operation_fence",
        ),
      ],
    });
    expect(
      migrations.find((migration) => migration.id === "0071_repair_canonical_activity_type_reads"),
    ).toMatchObject({
      id: "0071_repair_canonical_activity_type_reads",
      statements: expect.arrayContaining([
        "DROP VIEW IF EXISTS analytics.v_activity",
        "DROP VIEW IF EXISTS analytics.activity_summary",
        expect.stringContaining("ENGINE = Join(ANY, LEFT, activity_id)"),
        expect.stringContaining("ALTER TABLE analytics.activity_summary_rows"),
      ]),
      run: expect.any(Function),
    });
    expect(
      migrations.find((migration) => migration.id === "0072_canonical_clinical_records"),
    ).toMatchObject({
      id: "0072_canonical_clinical_records",
      statements: expect.arrayContaining([
        "DROP VIEW IF EXISTS analytics.provider_change_from_lab_panel",
        "DROP VIEW IF EXISTS analytics.provider_change_from_lab_result",
        expect.stringContaining("FROM postgres_fitness.clinical_record"),
      ]),
    });
  });

  it("rejects duplicate migration ids", async () => {
    vi.doMock("./0058_migrate_body_measurement_to_dbt.ts", () => ({
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
    vi.doMock("./0058_migrate_body_measurement_to_dbt.ts", () => ({
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
    vi.doMock("./0058_migrate_body_measurement_to_dbt.ts", () => ({
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
    vi.doMock("./0058_migrate_body_measurement_to_dbt.ts", () => ({
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
    vi.doMock("./0058_migrate_body_measurement_to_dbt.ts", () => ({
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
