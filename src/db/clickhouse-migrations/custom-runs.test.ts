import { beforeEach, describe, expect, it, vi } from "vitest";

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
  parsePostgresConnectionForClickHouse: vi.fn().mockReturnValue({ hostAndPort: "localhost:5432", database: "test", user: "test", password: "test" }),
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
  replaceNativeMetricStreamAndBackfill,
  repairNativeMetricStreamBackfill,
  rebuildMetricStreamLocationPoint,
  replaceLegacyMetricStreamIfNeeded,
} = await import("./custom-runs.ts");

function mockQueryClient(jsonResult: unknown) {
  return {
    query: vi.fn().mockReturnValue({ json: () => jsonResult }),
    command: vi.fn(),
  };
}

describe("replaceNativeMetricStreamAndBackfill", () => {
  it("rejects a client without query method at the database check guard", async () => {
    const client = { command: vi.fn() };
    await expect(replaceNativeMetricStreamAndBackfill(client as never, "conn")).rejects.toThrow(
      "ClickHouse migrations require a query-capable client",
    );
  });

  it("drops the postgres_fitness database when its engine is not Atomic or Ordinary", async () => {
    const client = mockQueryClient([{ engine: "PostgreSQL" }]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");
    await replaceNativeMetricStreamAndBackfill(client as never, "conn");
    expect(runClickHouseMigrationStatement).toHaveBeenCalledWith(
      client,
      "DROP DATABASE IF EXISTS postgres_fitness SYNC",
    );
  });

  it("skips dropping postgres_fitness database when its engine is Atomic", async () => {
    const client = mockQueryClient([{ engine: "Atomic" }]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");
    await replaceNativeMetricStreamAndBackfill(client as never, "conn");
    // Should NOT attempt to DROP DATABASE for Atomic engine
    expect(
      (runClickHouseMigrationStatement as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[1] as string).includes("DROP DATABASE"),
      ),
    ).toHaveLength(0);
  });

  it("skips dropping postgres_fitness when system.databases has no matching row", async () => {
    const client = mockQueryClient([]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");
    await replaceNativeMetricStreamAndBackfill(client as never, "conn");
    expect(
      (runClickHouseMigrationStatement as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[1] as string).includes("DROP DATABASE"),
      ),
    ).toHaveLength(0);
  });
});

describe("repairNativeMetricStreamBackfill", () => {
  it("rejects a client without query method at the column check guard", async () => {
    const client = { command: vi.fn() };
    await expect(repairNativeMetricStreamBackfill(client as never, "conn")).rejects.toThrow(
      "ClickHouse migrations require a query-capable client",
    );
  });

  it("skips backfill when the mirror has fewer columns than required", async () => {
    const client = mockQueryClient([{ migration_count: 1 }]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");
    await repairNativeMetricStreamBackfill(client as never, "conn");
    // When columns don't match, the function logs and returns — no migration statement should run
    expect(runClickHouseMigrationStatement).not.toHaveBeenCalled();
  });
});

describe("rebuildMetricStreamLocationPoint", () => {
  it("rejects a client without query method at the column check guard", async () => {
    const client = { command: vi.fn() };
    await expect(rebuildMetricStreamLocationPoint(client as never, "conn")).rejects.toThrow(
      "ClickHouse migrations require a query-capable client",
    );
  });
});

describe("replaceLegacyMetricStreamIfNeeded", () => {
  it("rejects a client without query method at the table check guard", async () => {
    const client = { command: vi.fn() };
    await expect(replaceLegacyMetricStreamIfNeeded(client as never, "conn")).rejects.toThrow(
      "ClickHouse migrations require a query-capable client",
    );
  });

  it("replaces the table when its engine is not ReplacingMergeTree", async () => {
    const client = mockQueryClient([{ engine: "MergeTree" }]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");
    await replaceLegacyMetricStreamIfNeeded(client as never, "conn");
    // Should proceed with bootstrap statements
    expect(runClickHouseMigrationStatement).toHaveBeenCalled();
  });

  it("returns early when the table engine IS ReplacingMergeTree", async () => {
    const client = mockQueryClient([{ engine: "ReplacingMergeTree" }]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");
    await replaceLegacyMetricStreamIfNeeded(client as never, "conn");
    // Should NOT run any migration statements (returns early)
    expect(runClickHouseMigrationStatement).not.toHaveBeenCalled();
  });

  it("returns early when system.tables has no matching row", async () => {
    const client = mockQueryClient([]);
    const { runClickHouseMigrationStatement } = await import("./statement-runner.ts");
    await replaceLegacyMetricStreamIfNeeded(client as never, "conn");
    expect(runClickHouseMigrationStatement).not.toHaveBeenCalled();
  });
});
