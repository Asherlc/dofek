import { describe, expect, it, vi } from "vitest";
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
        "analytics.deduped_location",
        "analytics.activity_summary",
        "analytics.activity_trend_daily",
      ]) {
        await client.command({
          query: `CREATE MATERIALIZED VIEW IF NOT EXISTS ${viewName}
REFRESH EVERY 1 MINUTE
ENGINE = MergeTree
ORDER BY tuple()
SETTINGS allow_nullable_key = 1
AS
SELECT 1 AS value`,
        });
      }
      return 0;
    },
  ),
}));

describe("clickhouse integration test helpers", () => {
  it("syncs raw mirrored tables and populates stored test read models", async () => {
    clickHouseMocks.command.mockReset().mockResolvedValue(undefined);
    clickHouseMocks.query.mockReset().mockResolvedValue({ json: vi.fn().mockResolvedValue([]) });
    clickHouseMocks.close.mockReset().mockResolvedValue(undefined);
    clickHouseMocks.createClickHouseClientFromEnv.mockReset().mockReturnValue({
      close: clickHouseMocks.close,
      command: clickHouseMocks.command,
      query: clickHouseMocks.query,
    });
    const testContext = {
      addCleanup: vi.fn(),
      connectionString: "postgres://health:fixture@db:5432/health",
    };

    await createClickHouseTestActivitySensorStore(testContext);
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
    expect(commands.every((command) => !command.includes("SYSTEM REFRESH VIEW"))).toBe(true);
    expect(commands.every((command) => !command.includes("SYSTEM WAIT VIEW"))).toBe(true);
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
          command.includes("INSERT INTO analytics_test_") && command.includes(".deduped_location"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("INSERT INTO analytics_test_") && command.includes(".activity_summary"),
      ),
    ).toBe(true);
    expect(commands.filter((command) => command === "SELECT 1")).toHaveLength(10);
  });
});
