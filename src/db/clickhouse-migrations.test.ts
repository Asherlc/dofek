import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "./clickhouse.ts";
import type { ClickHouseMigration } from "./clickhouse-migrations/types.ts";

const { mockClickHouseMigrations, mockRunClickHouseMigrationStatement } = vi.hoisted(() => ({
  mockClickHouseMigrations: vi.fn<() => ClickHouseMigration[]>(),
  mockRunClickHouseMigrationStatement: vi.fn(),
}));

vi.mock("./clickhouse-migrations/registry.ts", () => ({
  clickHouseMigrations: mockClickHouseMigrations,
}));

vi.mock("./clickhouse-migrations/statement-runner.ts", () => ({
  runClickHouseMigrationStatement: mockRunClickHouseMigrationStatement,
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { runClickHouseMigrations } from "./clickhouse-migrations.ts";

function makeClient(
  appliedMigrationIds: string[] = [],
  physicalTables: readonly object[] = [],
): ClickHouseCommandClient {
  return {
    command: vi.fn(),
    query: async <TRow extends object>({ query }: { query: string }) => ({
      json: async (): Promise<TRow[]> => {
        if (query.includes("SELECT count() AS tables"))
          return JSON.parse(JSON.stringify([{ tables: physicalTables.length, bytes: 1024 }]));
        if (query.includes("FROM system.tables")) return JSON.parse(JSON.stringify(physicalTables));
        const row = {
          migration_count: appliedMigrationIds.some((migrationId) =>
            query.includes(`'${migrationId}'`),
          )
            ? 1
            : 0,
        };
        return JSON.parse(JSON.stringify([row]));
      },
    }),
  };
}

describe("runClickHouseMigrations", () => {
  beforeEach(() => {
    mockClickHouseMigrations.mockReset();
    mockRunClickHouseMigrationStatement.mockReset();
  });

  it("rejects an uncovered physical table at startup even when no migrations are pending", async () => {
    mockClickHouseMigrations.mockReturnValue([]);
    const client = makeClient(
      [],
      [
        {
          uuid: "10000000-0000-4000-8000-000000001994",
          age_milliseconds: 0,
          database: "analytics",
          name: "unclassified_rows",
          engine: "MergeTree",
          columns: [["id", "UUID"]],
        },
      ],
    );
    await expect(runClickHouseMigrations(client, "postgres://test")).rejects.toThrow(
      "Unclassified ClickHouse UUID identity ownership domain: analytics.unclassified_rows.id",
    );
  });

  it("runs statement migrations and records them", async () => {
    mockClickHouseMigrations.mockReturnValue([
      { id: "0001_test", statements: ["CREATE TABLE analytics.test (id String)"] },
    ]);
    const client = makeClient();

    await expect(runClickHouseMigrations(client, "postgres://test")).resolves.toBe(1);

    expect(mockRunClickHouseMigrationStatement).toHaveBeenCalledWith(
      client,
      "CREATE TABLE analytics.test (id String)",
    );
    expect(client.command).toHaveBeenCalledWith({
      query: "INSERT INTO analytics.schema_migrations (id) VALUES ('0001_test')",
    });
  });

  it("runs custom migration bodies instead of statements", async () => {
    const run = vi.fn(async () => undefined);
    mockClickHouseMigrations.mockReturnValue([
      { id: "0001_custom", statements: ["SHOULD NOT RUN"], run },
    ]);
    const client = makeClient();

    await expect(runClickHouseMigrations(client, "postgres://test")).resolves.toBe(1);

    expect(run).toHaveBeenCalledWith(client, "postgres://test");
    expect(mockRunClickHouseMigrationStatement).not.toHaveBeenCalled();
  });

  it("skips a migration body when its prerequisite was not applied before this run", async () => {
    const run = vi.fn(async () => undefined);
    mockClickHouseMigrations.mockReturnValue([
      { id: "0001_prerequisite", statements: ["CREATE TABLE analytics.one (id String)"] },
      {
        id: "0002_dependent",
        requiresPreviouslyAppliedMigrationId: "0001_prerequisite",
        statements: ["SHOULD NOT RUN"],
        run,
      },
    ]);
    const client = makeClient();

    await expect(runClickHouseMigrations(client, "postgres://test")).resolves.toBe(2);

    expect(run).not.toHaveBeenCalled();
    expect(mockRunClickHouseMigrationStatement).toHaveBeenCalledTimes(1);
    expect(client.command).toHaveBeenCalledWith({
      query: "INSERT INTO analytics.schema_migrations (id) VALUES ('0002_dependent')",
    });
  });

  it("runs a dependent migration when its prerequisite was already applied", async () => {
    const run = vi.fn(async () => undefined);
    mockClickHouseMigrations.mockReturnValue([
      { id: "0001_prerequisite", statements: ["CREATE TABLE analytics.one (id String)"] },
      {
        id: "0002_dependent",
        requiresPreviouslyAppliedMigrationId: "0001_prerequisite",
        statements: [],
        run,
      },
    ]);
    const client = makeClient(["0001_prerequisite"]);

    await expect(runClickHouseMigrations(client, "postgres://test")).resolves.toBe(1);

    expect(run).toHaveBeenCalledWith(client, "postgres://test");
  });

  it("runs only pre-CDC additive migrations when preparing mirror compatibility", async () => {
    mockClickHouseMigrations.mockReturnValue([
      { id: "0001_main", statements: ["MAIN"] },
      { id: "0002_expand", phase: "pre-cdc", statements: ["EXPAND"] },
    ]);
    const client = makeClient();

    await expect(
      runClickHouseMigrations(client, "postgres://test", { phase: "pre-cdc" }),
    ).resolves.toBe(1);

    expect(mockRunClickHouseMigrationStatement).toHaveBeenCalledOnce();
    expect(mockRunClickHouseMigrationStatement).toHaveBeenCalledWith(client, "EXPAND");
  });
});
