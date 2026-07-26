import { describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { createMigration } from "./0055_provider_connection_catalog.ts";

describe("0055_provider_connection_catalog", () => {
  it("rebuilds the provider catalog and creates the connection mirror", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0055_provider_connection_catalog");
    expect(migration.statements).toEqual([
      expect.stringContaining("user_id Nullable(UUID)"),
      expect.stringContaining("CREATE TABLE IF NOT EXISTS postgres_fitness.provider_connection"),
    ]);
    expect(migration.statements[1]).toContain("SETTINGS allow_nullable_key = 1");
    expect(migration.run).toEqual(expect.any(Function));
  });

  it("rebuilds a legacy provider table before creating the connection mirror", async () => {
    const { client, commands } = createClient([
      [{ table_count: 0 }],
      [{ table_count: "1" }],
      [{ type: "UUID", is_in_sorting_key: "1" }],
    ]);

    await runMigration(client);

    expect(commands).toHaveLength(8);
    expect(commands[0]).toContain("DROP TABLE IF EXISTS postgres_fitness.provider_catalog_next");
    expect(commands[1]).toContain("CREATE TABLE postgres_fitness.provider_catalog_next");
    expect(commands[2]).toContain("INSERT INTO postgres_fitness.provider_catalog_next");
    expect(commands[4]).toContain(
      "RENAME TABLE postgres_fitness.provider TO postgres_fitness.provider_before_catalog_migration",
    );
    expect(commands[5]).toContain("SELECT id, name, api_base_url, user_id, created_at");
    expect(commands[6]).toBe(
      "DROP TABLE IF EXISTS postgres_fitness.provider_before_catalog_migration",
    );
    expect(commands[7]).toContain(
      "CREATE TABLE IF NOT EXISTS postgres_fitness.provider_connection",
    );
  });

  it("creates a missing provider table without running a rebuild", async () => {
    const { client, commands } = createClient([[{ table_count: 0 }], [{ table_count: 0 }]]);

    await runMigration(client);

    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("CREATE TABLE IF NOT EXISTS postgres_fitness.provider");
    expect(commands[1]).toContain(
      "CREATE TABLE IF NOT EXISTS postgres_fitness.provider_connection",
    );
  });

  it("leaves an already canonical provider table intact", async () => {
    const { client, commands } = createClient([
      [{ table_count: 0 }],
      [{ table_count: 1 }],
      [{ type: "Nullable(UUID)", is_in_sorting_key: 0 }],
    ]);

    await runMigration(client);

    expect(commands).toEqual([
      expect.stringContaining("CREATE TABLE IF NOT EXISTS postgres_fitness.provider_connection"),
    ]);
  });

  it("restores an interrupted backup when the provider table is absent", async () => {
    const { client, commands } = createClient([
      [{ table_count: 1 }],
      [{ table_count: 0 }],
      [{ table_count: 1 }],
      [{ type: "Nullable(UUID)", is_in_sorting_key: 0 }],
    ]);

    await runMigration(client);

    expect(commands).toEqual([
      "RENAME TABLE postgres_fitness.provider_before_catalog_migration TO postgres_fitness.provider",
      expect.stringContaining("CREATE TABLE IF NOT EXISTS postgres_fitness.provider_connection"),
    ]);
  });

  it("merges an interrupted backup into an existing canonical provider table", async () => {
    const { client, commands } = createClient([
      [{ table_count: 1 }],
      [{ table_count: 1 }],
      [{ table_count: 1 }],
      [{ type: "Nullable(UUID)", is_in_sorting_key: 0 }],
    ]);

    await runMigration(client);

    expect(commands[0]).toContain(
      "INSERT INTO postgres_fitness.provider (id, name, api_base_url, user_id",
    );
    expect(commands[1]).toBe(
      "DROP TABLE IF EXISTS postgres_fitness.provider_before_catalog_migration",
    );
    expect(commands[2]).toContain(
      "CREATE TABLE IF NOT EXISTS postgres_fitness.provider_connection",
    );
  });

  it("fails when ClickHouse queries are unavailable", async () => {
    const client: ClickHouseCommandClient = {
      command: vi.fn(),
    };

    await expect(runMigration(client)).rejects.toThrow(
      "ClickHouse migrations require a query-capable client",
    );
  });

  it("fails when table metadata has an invalid shape", async () => {
    const { client } = createClient([[{}]]);

    await expect(runMigration(client)).rejects.toThrow();
  });

  it("fails when provider column metadata has an invalid shape", async () => {
    const { client } = createClient([
      [{ table_count: 0 }],
      [{ table_count: 1 }],
      [{ type: "UUID" }],
    ]);

    await expect(runMigration(client)).rejects.toThrow();
  });

  it("fails when the provider user_id column is absent", async () => {
    const { client } = createClient([[{ table_count: 0 }], [{ table_count: 1 }], []]);

    await expect(runMigration(client)).rejects.toThrow(
      "postgres_fitness.provider is missing required user_id column",
    );
  });
});

async function runMigration(client: ClickHouseCommandClient): Promise<void> {
  const run = createMigration().run;
  if (!run) {
    throw new Error("0055 migration must define a custom runner");
  }
  await run(client, "postgres://unused");
}

function createClient(queryRows: readonly object[][]): {
  client: ClickHouseCommandClient;
  commands: string[];
} {
  const responses = [...queryRows];
  const commands: string[] = [];
  return {
    commands,
    client: {
      command: vi.fn(async ({ query }) => {
        commands.push(query);
      }),
      query: async <TRow extends object>() => ({
        json: async (): Promise<TRow[]> => JSON.parse(JSON.stringify(responses.shift() ?? [])),
      }),
    },
  };
}
