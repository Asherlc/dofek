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
  processDedupedSensorDirtyKeys: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../../../../src/db/clickhouse.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../src/db/clickhouse.ts")>();
  return {
    ...original,
    createClickHouseClientFromEnv: clickHouseMocks.createClickHouseClientFromEnv,
  };
});

vi.mock("../../../../src/db/clickhouse-deduped-sensor.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../../src/db/clickhouse-deduped-sensor.ts")>();
  return {
    ...original,
    processDedupedSensorDirtyKeys: clickHouseMocks.processDedupedSensorDirtyKeys,
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
    clickHouseMocks.processDedupedSensorDirtyKeys.mockReset().mockResolvedValue(0);
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
          command.includes("CREATE VIEW IF NOT EXISTS analytics_test_") &&
          command.includes(".v_daily_metrics"),
      ),
    ).toBe(false);

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
          command.includes("INSERT INTO analytics_test_") &&
          command.includes(".v_daily_metrics") &&
          command.includes("\nSELECT"),
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
          command.includes(".resting_heart_rate_sleep_window"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("INSERT INTO analytics_test_") && command.includes(".activity_summary"),
      ),
    ).toBe(true);
    expect(commands.filter((command) => command === "SELECT 1")).toHaveLength(0);
  });

  it("drains deduped sensor dirty keys until no pending rows remain", async () => {
    clickHouseMocks.processDedupedSensorDirtyKeys
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);
    const testContext = {
      addCleanup: vi.fn(),
      connectionString: "postgres://health:fixture@db:5432/health",
    };

    await createClickHouseTestActivitySensorStore(testContext);

    expect(clickHouseMocks.processDedupedSensorDirtyKeys).toHaveBeenCalledTimes(3);
  });

  it("fails when the deduped sensor dirty-key backlog does not drain", async () => {
    clickHouseMocks.processDedupedSensorDirtyKeys.mockResolvedValue(1);
    const testContext = {
      addCleanup: vi.fn(),
      connectionString: "postgres://health:fixture@db:5432/health",
    };

    await expect(createClickHouseTestActivitySensorStore(testContext)).rejects.toThrow(
      "ClickHouse test sensor dirty-key backlog did not drain",
    );
    expect(clickHouseMocks.processDedupedSensorDirtyKeys).toHaveBeenCalledTimes(1000);
  });
});
