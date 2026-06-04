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
      for (const viewName of [
        "analytics.v_activity",
        "analytics.v_activity_members",
        "analytics.v_sleep",
        "analytics.v_body_measurement",
        "analytics.v_daily_metrics",
        "analytics.provider_stats",
        "analytics.deduped_sensor",
        "analytics.resting_heart_rate_sleep_window",
        "analytics.deduped_location",
        "analytics.activity_summary",
        "analytics.activity_trend_daily",
      ]) {
        await client.command({
          query: `CREATE VIEW IF NOT EXISTS ${viewName}
AS
SELECT 1 AS value`,
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
    expect(
      commands.some(
        (command) =>
          command.includes("INSERT INTO analytics_test_") &&
          command.includes(".provider_stats") &&
          command.includes("AS is_deleted") &&
          command.includes("AS refresh_version") &&
          command.includes("AS refreshed_at"),
      ),
    ).toBe(true);
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
          command.includes("INSERT INTO analytics_test_") && command.includes(".activity_summary"),
      ),
    ).toBe(true);
  });
});
