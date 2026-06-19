import { describe, expect, it } from "vitest";
import { clickHouseMigrationFileNames, clickHouseMigrations } from "./registry.ts";

describe("clickHouseMigrations", () => {
  it("creates serving dbt tables before the web service can query them", () => {
    const migrations = clickHouseMigrations("postgres://health:test@localhost:5432/health");
    const statements = migrations.flatMap((migration) => migration.statements);

    expect(clickHouseMigrationFileNames).toContain("0024_create_dbt_serving_read_model_tables.ts");
    expect(statements).toContainEqual(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.daily_recovery_inputs"),
    );
    expect(statements).toContainEqual(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.daily_activity_load"),
    );
    expect(statements).toContainEqual(
      expect.stringContaining(
        "CREATE TABLE IF NOT EXISTS analytics.healthspan_activity_zone_minutes",
      ),
    );
    expect(statements).toContainEqual(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.deduped_activities"),
    );
    expect(clickHouseMigrationFileNames).toContain("0026_create_dashboard_tables.ts");
    expect(clickHouseMigrationFileNames).toContain("0027_create_daily_sleep_table.ts");
    expect(clickHouseMigrationFileNames).toContain("0028_create_domain_dashboard_tables.ts");
    expect(clickHouseMigrationFileNames).toContain("0030_activity_mirror_order_key.ts");
    expect(clickHouseMigrationFileNames).toContain("0031_activity_user_soft_delete.ts");
    expect(clickHouseMigrationFileNames).toContain(
      "0032_deduped_activities_absent_source_links.ts",
    );
    expect(clickHouseMigrationFileNames).toContain(
      "0033_recreate_deduped_activities_column_order.ts",
    );
    expect(statements).toContainEqual(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.provider_stats"),
    );
    expect(statements).toContainEqual(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.daily_recovery"),
    );
    expect(statements).toContainEqual(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.daily_strain"),
    );
    expect(statements).toContainEqual(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.weekly_healthspan"),
    );
    expect(statements).toContainEqual(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.daily_sleep"),
    );
    expect(migrations).toContainEqual(
      expect.objectContaining({
        id: "0030_activity_mirror_order_key",
        run: expect.any(Function),
      }),
    );
    expect(migrations).toContainEqual(
      expect.objectContaining({
        id: "0033_recreate_deduped_activities_column_order",
        statements: expect.arrayContaining([
          "DROP TABLE IF EXISTS analytics.deduped_activities",
          expect.stringContaining("CREATE TABLE IF NOT EXISTS analytics.deduped_activities"),
        ]),
      }),
    );
  });
});
