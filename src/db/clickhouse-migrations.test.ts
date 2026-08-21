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

function makeClient(appliedMigrationIds: string[] = []): ClickHouseCommandClient {
  return {
    command: vi.fn(),
    query: async <TRow extends object>({ query }: { query: string }) => ({
      json: async (): Promise<TRow[]> => {
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
});
