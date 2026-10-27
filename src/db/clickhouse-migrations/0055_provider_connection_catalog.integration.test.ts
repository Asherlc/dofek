import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ClickHouseClient,
  type ClickHouseCommandClient,
  createClickHouseClientFromEnv,
} from "../clickhouse.ts";
import { createMigration } from "./0055_provider_connection_catalog.ts";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";

const providerColumnSchema = z.object({
  type: z.string(),
  is_in_sorting_key: z.coerce.number(),
});

const providerTableSchema = z.object({
  sorting_key: z.string(),
});

const providerRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  user_id: z.string().nullable(),
  _peerdb_version: z.coerce.number(),
});

const tableCountSchema = z.object({
  table_count: z.coerce.number(),
});

describe("0055_provider_connection_catalog migration", () => {
  const targetDatabase = `provider_connection_migration_test_${randomBytes(6).toString("hex")}`;
  let client: ClickHouseClient | undefined;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv(undefined, { requestTimeoutMs: 120_000 });
    await client.command({ query: `CREATE DATABASE ${targetDatabase}` });
    await client.command({
      query: `CREATE TABLE ${targetDatabase}.provider (
        id String,
        name String,
        api_base_url Nullable(String),
        user_id UUID,
        created_at DateTime64(6, 'UTC'),
        _peerdb_synced_at DateTime64(9) DEFAULT now(),
        _peerdb_is_deleted Int8 DEFAULT 0,
        _peerdb_version Int64 DEFAULT 0
      )
      ENGINE = ReplacingMergeTree(_peerdb_version)
      ORDER BY (user_id, id)
      SETTINGS allow_nullable_key = 1`,
    });
    await client.command({
      query: `INSERT INTO ${targetDatabase}.provider (
        id, name, api_base_url, user_id, created_at,
        _peerdb_synced_at, _peerdb_is_deleted, _peerdb_version
      ) VALUES (
        'withings',
        'Withings',
        'https://wbsapi.withings.net',
        '00000000-0000-4000-8000-000000005500',
        now64(6),
        now64(9),
        0,
        7
      )`,
    });
  });

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${targetDatabase} SYNC` });
      await client.close?.();
    }
  });

  it("rebuilds the legacy provider sorting key while preserving rows", async () => {
    const activeClient = requireClient(client);
    const scopedClient = createDatabaseScopedClient(activeClient, targetDatabase);
    const migration = createMigration();

    if (migration.run) {
      await migration.run(scopedClient, "postgres://unused");
    } else {
      for (const statement of migration.statements) {
        await runClickHouseMigrationStatement(scopedClient, statement);
      }
    }

    const columnResult = await activeClient.query({
      query: `SELECT type, is_in_sorting_key
        FROM system.columns
        WHERE database = {database:String}
          AND table = 'provider'
          AND name = 'user_id'`,
      query_params: { database: targetDatabase },
      format: "JSONEachRow",
    });
    expect(providerColumnSchema.parse((await columnResult.json())[0])).toEqual({
      type: "Nullable(UUID)",
      is_in_sorting_key: 0,
    });

    const tableResult = await activeClient.query({
      query: `SELECT sorting_key
        FROM system.tables
        WHERE database = {database:String}
          AND name = 'provider'`,
      query_params: { database: targetDatabase },
      format: "JSONEachRow",
    });
    expect(providerTableSchema.parse((await tableResult.json())[0])).toEqual({
      sorting_key: "(id)",
    });

    const rowResult = await activeClient.query({
      query: `SELECT id, name, user_id, _peerdb_version
        FROM ${targetDatabase}.provider FINAL`,
      format: "JSONEachRow",
    });
    expect(z.array(providerRowSchema).parse(await rowResult.json())).toEqual([
      {
        id: "withings",
        name: "Withings",
        user_id: "00000000-0000-4000-8000-000000005500",
        _peerdb_version: 7,
      },
    ]);

    const connectionTableResult = await activeClient.query({
      query: `SELECT count() AS table_count
        FROM system.tables
        WHERE database = {database:String}
          AND name = 'provider_connection'`,
      query_params: { database: targetDatabase },
      format: "JSONEachRow",
    });
    expect(tableCountSchema.parse((await connectionTableResult.json())[0]).table_count).toBe(1);
  });
});

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) {
    throw new Error("ClickHouse client was not initialized");
  }
  return client;
}

function createDatabaseScopedClient(
  client: ClickHouseClient,
  targetDatabase: string,
): ClickHouseCommandClient {
  const rewriteQuery = (query: string) =>
    query
      .replaceAll("postgres_fitness.", `${targetDatabase}.`)
      .replaceAll("'postgres_fitness'", `'${targetDatabase}'`);

  return {
    command: ({ query, ...options }) =>
      client.command({
        ...options,
        query: rewriteQuery(query),
      }),
    query: <TRow extends object>({ query, ...options }: Parameters<ClickHouseClient["query"]>[0]) =>
      client.query<TRow>({
        ...options,
        query: rewriteQuery(query),
      }),
  };
}
