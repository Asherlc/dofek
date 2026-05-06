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
  runClickHouseMigrations: vi.fn().mockResolvedValue(0),
}));

describe("clickhouse integration test helpers", () => {
  it("syncs raw mirrored tables and refreshes all analytics read models", async () => {
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
          command.endsWith(".body_measurement"),
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
          command.includes("INSERT INTO postgres_fitness_test_") &&
          command.includes(".activity") &&
          command.includes("FROM postgresql('db:5432', 'health', 'activity'"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("SYSTEM REFRESH VIEW analytics_test_") &&
          command.endsWith(".v_daily_metrics"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("SYSTEM WAIT VIEW analytics_test_") &&
          command.endsWith(".provider_stats"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("SYSTEM REFRESH VIEW analytics_test_") &&
          command.endsWith(".deduped_sensor"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes("SYSTEM WAIT VIEW analytics_test_") &&
          command.endsWith(".activity_summary"),
      ),
    ).toBe(true);
  });
});
