import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { clickHouseStringLiteral } from "../db/clickhouse-migrations/sql.ts";
import { inspectClickHouseAccountErasureCoverage } from "./clickhouse-erasure-coverage.ts";

describe("ClickHouse erasure catalog coverage (integration)", () => {
  let client: ClickHouseClient;

  beforeAll(() => {
    client = createClickHouseClientFromEnv();
  });

  afterAll(async () => {
    await client.close?.();
  });

  async function withCatalog(run: (database: string) => Promise<void>): Promise<void> {
    const database = `erasure_catalog_${randomUUID().replaceAll("-", "")}`;
    await client.command({ query: `CREATE DATABASE ${database}` });
    try {
      await run(database);
    } finally {
      await client.command({ query: `DROP DATABASE ${database} SYNC` });
    }
  }

  it("inspects every column in a production-sized catalog and still rejects unowned identities", async () => {
    await withCatalog(async (database) => {
      const columns = Array.from(
        { length: 80 },
        (_, index) => [`sample_value_${index}`, "Float64"] as const,
      );
      const definitions = columns.map(([name, type]) => `${name} ${type}`).join(", ");
      const names = Array.from({ length: 40 }, (_, index) => `samples_${index}`);
      for (const name of names) {
        await client.command({
          query: `CREATE TABLE ${database}.${name} (user_id UUID, ${definitions})
            ENGINE = MergeTree ORDER BY user_id`,
        });
      }

      const tables = await inspectClickHouseAccountErasureCoverage(client, {
        managedDatabases: [database],
      });
      expect(tables.map((table) => table.name).sort()).toEqual([...names].sort());
      for (const table of tables) {
        expect(new Map(table.columns)).toEqual(new Map([["user_id", "UUID"], ...columns]));
      }

      await client.command({
        query: `CREATE TABLE ${database}.unowned (id UUID) ENGINE = MergeTree ORDER BY id`,
      });
      await expect(
        inspectClickHouseAccountErasureCoverage(client, { managedDatabases: [database] }),
      ).rejects.toThrow("Unclassified ClickHouse UUID identity ownership domain");
    });
  });

  it("preserves escaped type metadata in a catalog within the byte budget", async () => {
    await withCatalog(async (database) => {
      const label = 'quoted "value" with \\ slash / newline\n and unicode μ'.repeat(12);
      const type = `Enum8(${clickHouseStringLiteral(label)} = 1)`;
      const definitions = Array.from({ length: 64 }, (_, index) => `sample_${index} ${type}`);
      await client.command({
        query: `CREATE TABLE ${database}.escaped (user_id UUID, ${definitions.join(", ")})
          ENGINE = MergeTree ORDER BY user_id`,
      });

      const tables = await inspectClickHouseAccountErasureCoverage(client, {
        managedDatabases: [database],
      });
      const expected = await client.query<{ name: string; type: string }>({
        query: `SELECT name, type FROM system.columns WHERE database = {database:String}`,
        query_params: { database },
        format: "JSONEachRow",
      });
      expect(tables).toHaveLength(1);
      expect(tables[0]?.columns).toHaveLength(65);
      expect(new Map(tables[0]?.columns)).toEqual(
        new Map((await expected.json()).map(({ name, type }) => [name, type])),
      );
    });
  });

  it("rejects a catalog whose encoded column metadata exceeds one MiB", async () => {
    await withCatalog(async (database) => {
      const type = `Enum8(${clickHouseStringLiteral("x".repeat(12_000))} = 1)`;
      const definitions = Array.from({ length: 16 }, (_, index) => `sample_${index} ${type}`);
      for (let index = 0; index < 8; index += 1) {
        await client.command({
          query: `CREATE TABLE ${database}.oversized_${index} (user_id UUID, ${definitions.join(", ")})
            ENGINE = MergeTree ORDER BY user_id`,
        });
      }

      await expect(
        inspectClickHouseAccountErasureCoverage(client, { managedDatabases: [database] }),
      ).rejects.toThrow("500-table/1 MiB metadata budget");
    });
  });
});
