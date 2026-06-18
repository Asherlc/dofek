import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";

beforeEach(() => {
  vi.clearAllMocks();
});

vi.mock("pg", () => {
  const mockClient = {
    connect: vi.fn(),
    query: vi.fn().mockResolvedValue({ rows: [] }),
    end: vi.fn(),
  };
  return { Client: vi.fn(() => mockClient) };
});

vi.mock("./statement-runner.ts", () => ({
  runClickHouseMigrationStatement: vi.fn(),
}));

vi.mock("../clickhouse.ts", () => ({
  waitForClickHouseTable: vi.fn(),
  buildClickHouseBootstrapStatements: vi.fn().mockReturnValue([]),
  parsePostgresConnectionForClickHouse: vi.fn().mockReturnValue({
    hostAndPort: "localhost:5432",
    database: "test",
    user: "test",
    password: "test",
  }),
}));

vi.mock("../clickhouse-activity-trend-read-model.ts", () => ({
  buildActivityTrendDailyReadModelStatements: vi.fn().mockReturnValue([]),
}));

vi.mock("../clickhouse-deduped-sensor.ts", () => ({
  buildIncrementalDedupedSensorBaseTableStatements: vi.fn().mockReturnValue([]),
  buildIncrementalDedupedSensorResetStatements: vi.fn().mockReturnValue([]),
}));

vi.mock("../clickhouse-metric-stream-bootstrap.ts", () => ({
  buildActivitySummaryReadModelStatements: vi.fn().mockReturnValue([]),
}));

vi.mock("../../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  replaceActivityMirrorOrderKey,
  replaceNativeMetricStreamAndBackfill,
  repairNativeMetricStreamBackfill,
  rebuildMetricStreamLocationPoint,
  replaceLegacyMetricStreamIfNeeded,
} = await import("./custom-runs.ts");

function mockQueryClient(jsonResult: unknown): ClickHouseCommandClient {
  return {
    query: vi.fn().mockReturnValue({ json: () => jsonResult }),
    command: vi.fn(),
  };
}

describe("replaceNativeMetricStreamAndBackfill", () => {
  it("rejects a client without query method at the database check guard", async () => {
    const client: ClickHouseCommandClient = { command: vi.fn() };
    await expect(replaceNativeMetricStreamAndBackfill(client, "conn")).rejects.toThrow(
      "ClickHouse migrations require a query-capable client",
    );
  });

  it("drops the postgres_fitness database when its engine is not Atomic or Ordinary", async () => {
    const client = mockQueryClient([{ engine: "PostgreSQL" }]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");
    await replaceNativeMetricStreamAndBackfill(client, "conn");
    expect(runClickHouseMigrationStatement).toHaveBeenCalledWith(
      client,
      "DROP DATABASE IF EXISTS postgres_fitness SYNC",
    );
  });

  it("skips dropping postgres_fitness database when its engine is Atomic", async () => {
    const client = mockQueryClient([{ engine: "Atomic" }]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");
    await replaceNativeMetricStreamAndBackfill(client, "conn");
    const mockedRun = vi.mocked(runClickHouseMigrationStatement);
    const dropCalls = mockedRun.mock.calls.filter((call: unknown[]) =>
      String(call[1]).includes("DROP DATABASE"),
    );
    expect(dropCalls).toHaveLength(0);
  });

  it("skips dropping postgres_fitness database when its engine is Ordinary", async () => {
    const client = mockQueryClient([{ engine: "Ordinary" }]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");
    await replaceNativeMetricStreamAndBackfill(client, "conn");
    const mockedRun = vi.mocked(runClickHouseMigrationStatement);
    const dropCalls = mockedRun.mock.calls.filter((call: unknown[]) =>
      String(call[1]).includes("DROP DATABASE"),
    );
    expect(dropCalls).toHaveLength(0);
  });

  it("skips dropping postgres_fitness when system.databases has no matching row", async () => {
    const client = mockQueryClient([]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");
    await replaceNativeMetricStreamAndBackfill(client, "conn");
    const mockedRun = vi.mocked(runClickHouseMigrationStatement);
    const dropCalls = mockedRun.mock.calls.filter((call: unknown[]) =>
      String(call[1]).includes("DROP DATABASE"),
    );
    expect(dropCalls).toHaveLength(0);
  });
});

describe("replaceActivityMirrorOrderKey", () => {
  it("rejects a client without query method at the table definition check guard", async () => {
    const client: ClickHouseCommandClient = { command: vi.fn() };
    await expect(replaceActivityMirrorOrderKey(client, "conn")).rejects.toThrow(
      "ClickHouse migrations require a query-capable client",
    );
  });

  it("replaces the activity mirror when the order key still includes mutable columns", async () => {
    const client = mockQueryClient([
      {
        create_table_query:
          "CREATE TABLE postgres_fitness.activity ORDER BY (user_id, started_at, id)",
      },
    ]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");

    await replaceActivityMirrorOrderKey(client, "conn");

    expect(runClickHouseMigrationStatement).toHaveBeenCalledWith(
      client,
      expect.stringContaining("CREATE TABLE postgres_fitness.activity_order_key_next"),
    );
    expect(runClickHouseMigrationStatement).toHaveBeenCalledWith(
      client,
      expect.stringContaining("ORDER BY id"),
    );
    expect(runClickHouseMigrationStatement).toHaveBeenCalledWith(
      client,
      "INSERT INTO postgres_fitness.activity_order_key_next SELECT * FROM postgres_fitness.activity",
    );
    expect(runClickHouseMigrationStatement).toHaveBeenCalledWith(
      client,
      "RENAME TABLE postgres_fitness.activity TO postgres_fitness.activity_before_order_key_fix, postgres_fitness.activity_order_key_next TO postgres_fitness.activity",
    );
    expect(runClickHouseMigrationStatement).toHaveBeenCalledWith(
      client,
      "INSERT INTO postgres_fitness.activity SELECT * FROM postgres_fitness.activity_before_order_key_fix",
    );
  });

  it("returns early when the activity mirror already uses id as its order key", async () => {
    const client = mockQueryClient([
      { create_table_query: "CREATE TABLE postgres_fitness.activity ORDER BY id" },
    ]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");

    await replaceActivityMirrorOrderKey(client, "conn");

    expect(runClickHouseMigrationStatement).not.toHaveBeenCalled();
  });

  it("returns early when the activity mirror table does not exist", async () => {
    const client = mockQueryClient([]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");

    await replaceActivityMirrorOrderKey(client, "conn");

    expect(runClickHouseMigrationStatement).not.toHaveBeenCalled();
  });
});

describe("repairNativeMetricStreamBackfill", () => {
  it("rejects a client without query method at the column check guard", async () => {
    const client: ClickHouseCommandClient = { command: vi.fn() };
    await expect(repairNativeMetricStreamBackfill(client, "conn")).rejects.toThrow(
      "ClickHouse migrations require a query-capable client",
    );
  });

  it("skips backfill when the mirror has fewer columns than required", async () => {
    const client = mockQueryClient([{ migration_count: 1 }]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");
    await repairNativeMetricStreamBackfill(client, "conn");
    expect(runClickHouseMigrationStatement).not.toHaveBeenCalled();
  });
});

describe("rebuildMetricStreamLocationPoint", () => {
  it("rejects a client without query method at the column check guard", async () => {
    const client: ClickHouseCommandClient = { command: vi.fn() };
    await expect(rebuildMetricStreamLocationPoint(client, "conn")).rejects.toThrow(
      "ClickHouse migrations require a query-capable client",
    );
  });
});

describe("replaceLegacyMetricStreamIfNeeded", () => {
  it("rejects a client without query method at the table check guard", async () => {
    const client: ClickHouseCommandClient = { command: vi.fn() };
    await expect(replaceLegacyMetricStreamIfNeeded(client, "conn")).rejects.toThrow(
      "ClickHouse migrations require a query-capable client",
    );
  });

  it("replaces the table when its engine is not ReplacingMergeTree", async () => {
    const client = mockQueryClient([{ engine: "MergeTree" }]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");
    await replaceLegacyMetricStreamIfNeeded(client, "conn");
    expect(runClickHouseMigrationStatement).toHaveBeenCalled();
  });

  it("returns early when the table engine IS ReplacingMergeTree", async () => {
    const client = mockQueryClient([{ engine: "ReplacingMergeTree" }]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");
    await replaceLegacyMetricStreamIfNeeded(client, "conn");
    expect(runClickHouseMigrationStatement).not.toHaveBeenCalled();
  });

  it("returns early when system.tables has no matching row", async () => {
    const client = mockQueryClient([]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");
    await replaceLegacyMetricStreamIfNeeded(client, "conn");
    expect(runClickHouseMigrationStatement).not.toHaveBeenCalled();
  });
});
