import { beforeEach, describe, expect, it, vi } from "vitest";
import { runClickHouseMigrations } from "../../../../src/db/clickhouse-migrations.ts";
import {
  createClickHouseTestActivitySensorStore,
  syncClickHouseTestActivitySensorStore,
} from "./clickhouse-integration-test-helpers.ts";

const clickHouseMocks = vi.hoisted(() => ({
  close: vi.fn(),
  command: vi.fn(),
  createClickHouseClientFromEnv: vi.fn(),
  query: vi.fn(),
}));

const testAnalyticsViewNames = [
  "analytics.v_activity",
  "analytics.v_activity_members",
  "analytics.v_sleep",
  "analytics.v_body_measurement",
  "analytics.v_daily_metrics",
  "analytics.provider_stats",
  "analytics.deduped_sensor",
  "analytics.resting_heart_rate_sleep_window",
  "analytics.daily_recovery_inputs",
  "analytics.deduped_location",
  "analytics.activity_summary",
  "analytics.daily_activity_load",
  "analytics.healthspan_activity_zone_minutes",
  "analytics.activity_trend_daily",
];

vi.mock("../../../../src/db/clickhouse.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../src/db/clickhouse.ts")>();
  return {
    ...original,
    createClickHouseClientFromEnv: clickHouseMocks.createClickHouseClientFromEnv,
  };
});

vi.mock("../../../../src/db/clickhouse-migrations.ts", () => ({
  runClickHouseMigrations: vi.fn(
    async (client: { command(options: { query: string }): Promise<unknown> }) => {
      for (const viewName of testAnalyticsViewNames) {
        const selectSql =
          viewName === "analytics.provider_stats"
            ? `SELECT
  toUUID('00000000-0000-0000-0000-000000000001') AS user_id,
  'test-provider' AS provider_id,
  toUInt64(0) AS activities,
  toUInt64(0) AS daily_metrics,
  toUInt64(0) AS sleep_sessions,
  toUInt64(0) AS body_measurements,
  toUInt64(0) AS food_entries,
  toUInt64(0) AS health_events,
  toUInt64(0) AS metric_stream,
  toUInt64(0) AS nutrition_daily,
  toUInt64(0) AS lab_panels,
  toUInt64(0) AS lab_results,
  toUInt64(0) AS journal_entries,
  toUInt8(0) AS is_deleted,
  toUInt64(1) AS refresh_version,
  now64(9) AS refreshed_at`
            : "SELECT 1 AS value";
        await client.command({
          query: `CREATE VIEW IF NOT EXISTS ${viewName}
AS
${selectSql}`,
        });
      }
      return 0;
    },
  ),
}));

const mockRunClickHouseMigrations = vi.mocked(runClickHouseMigrations);

describe("clickhouse integration test helpers", () => {
  beforeEach(() => {
    clickHouseMocks.command.mockReset().mockResolvedValue(undefined);
    clickHouseMocks.query.mockReset().mockResolvedValue({ json: vi.fn().mockResolvedValue([]) });
    clickHouseMocks.close.mockReset().mockResolvedValue(undefined);
    clickHouseMocks.createClickHouseClientFromEnv.mockReset().mockReturnValue({
      close: clickHouseMocks.close,
      command: clickHouseMocks.command,
      query: clickHouseMocks.query,
    });
  });

  it("syncs raw mirrored tables and populates stored test analytics tables", async () => {
    const testContext = {
      addCleanup: vi.fn(),
      connectionString: "postgres://health:fixture@db:5432/health",
    };

    await createClickHouseTestActivitySensorStore(testContext);

    expect(mockRunClickHouseMigrations).not.toHaveBeenCalled();
    const setupCommands = clickHouseMocks.command.mock.calls.map(([options]) =>
      String(options.query),
    );
    expect(
      setupCommands.some(
        (command) =>
          command.includes("CREATE TABLE IF NOT EXISTS postgres_fitness_test_") &&
          command.includes(".metric_stream"),
      ),
    ).toBe(true);
    expect(
      setupCommands.some(
        (command) =>
          command.includes("CREATE TABLE IF NOT EXISTS analytics_test_") &&
          command.includes(".v_daily_metrics"),
      ),
    ).toBe(true);
    expect(
      setupCommands.some(
        (command) =>
          command.includes("CREATE TABLE IF NOT EXISTS analytics_test_") &&
          command.includes(".activity_vo2max_estimate"),
      ),
    ).toBe(true);
    expect(
      setupCommands.some(
        (command) =>
          command.includes("CREATE TABLE IF NOT EXISTS analytics_test_") &&
          command.includes(".activity_sensor_sample"),
      ),
    ).toBe(true);
    expect(
      setupCommands.some(
        (command) =>
          command.includes("CREATE TABLE IF NOT EXISTS analytics_test_") &&
          command.includes(".daily_recovery_inputs"),
      ),
    ).toBe(true);
    expect(
      setupCommands.some(
        (command) =>
          command.includes("CREATE TABLE IF NOT EXISTS analytics_test_") &&
          command.includes(".daily_activity_load"),
      ),
    ).toBe(true);
    expect(
      setupCommands.some(
        (command) =>
          command.includes("CREATE TABLE IF NOT EXISTS analytics_test_") &&
          command.includes(".healthspan_activity_zone_minutes"),
      ),
    ).toBe(true);

    clickHouseMocks.command.mockClear();

    await syncClickHouseTestActivitySensorStore(testContext);

    const commands = clickHouseMocks.command.mock.calls.map(([options]) => String(options.query));
    expect(
      commands.some(
        (command) =>
          command.includes("TRUNCATE TABLE postgres_fitness_test_") &&
          command.endsWith(".activity"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("TRUNCATE TABLE postgres_fitness_test_") &&
          command.endsWith(".sleep_session"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("TRUNCATE TABLE postgres_fitness_test_") &&
          command.endsWith(".daily_metrics"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("TRUNCATE TABLE postgres_fitness_test_") &&
          command.endsWith(".provider_priority"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("TRUNCATE TABLE postgres_fitness_test_") &&
          command.endsWith(".food_entry"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("TRUNCATE TABLE postgres_fitness_test_") &&
          command.endsWith(".journal_entry"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("INSERT INTO postgres_fitness_test_") &&
          command.includes(".activity") &&
          command.includes("FROM postgresql('db:5432', 'health', 'activity'"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("INSERT INTO postgres_fitness_test_") &&
          command.includes(".lab_result") &&
          command.includes("FROM postgresql('db:5432', 'health', 'lab_result'"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("TRUNCATE TABLE analytics_test_") &&
          command.endsWith(".deduped_activities"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("TRUNCATE TABLE analytics_test_") &&
          command.endsWith(".v_daily_metrics"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("INSERT INTO analytics_test_") &&
          command.includes(".v_daily_metrics") &&
          command.includes("\nSELECT"),
      ),
    ).toBe(true);
    const providerStatsInsert = commands.find(
      (command) =>
        command.includes("INSERT INTO analytics_test_") && command.includes(".provider_stats"),
    );
    expect(providerStatsInsert).toBeDefined();
    const providerStatsInsertSql = providerStatsInsert ?? "";
    expect(providerStatsInsertSql).toContain("AS is_deleted");
    expect(providerStatsInsertSql).toContain("AS refresh_version");
    expect(providerStatsInsertSql).toContain("AS refreshed_at");
    expect(providerStatsInsertSql).not.toContain("provider_stats.*");
    expect(
      commands.some(
        (command) =>
          command.includes("INSERT INTO analytics_test_") && command.includes(".deduped_location"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("INSERT INTO analytics_test_") &&
          command.includes(".sensor_scalar_sample") &&
          command.includes("FROM postgres_fitness_test_"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("INSERT INTO analytics_test_") &&
          command.includes(".deduped_sensor") &&
          command.includes("FROM analytics_test_"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("INSERT INTO analytics_test_") &&
          command.includes(".activity_sensor_sample") &&
          command.includes("FROM analytics_test_"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("TRUNCATE TABLE analytics_test_") &&
          command.endsWith(".activity_vo2max_estimate"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("INSERT INTO analytics_test_") &&
          command.includes(".resting_heart_rate_sleep_window"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("INSERT INTO analytics_test_") &&
          command.includes(".daily_recovery_inputs") &&
          command.includes(".v_daily_metrics"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("INSERT INTO analytics_test_") && command.includes(".activity_summary"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("INSERT INTO analytics_test_") &&
          command.includes(".daily_activity_load") &&
          command.includes(".activity_summary"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("INSERT INTO analytics_test_") &&
          command.includes(".healthspan_activity_zone_minutes") &&
          command.includes(".activity_sensor_sample"),
      ),
    ).toBe(true);
  });
});
