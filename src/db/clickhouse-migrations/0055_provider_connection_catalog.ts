import { z } from "zod";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import {
  buildPostgresFitnessProviderConnectionRawTableStatement,
  buildPostgresFitnessProviderRawTableStatement,
} from "../clickhouse-raw-tables.ts";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

const tableCountRowSchema = z.object({
  table_count: z.union([z.number(), z.string()]),
});

const providerColumnRowSchema = z.object({
  type: z.string(),
  is_in_sorting_key: z.union([z.number(), z.string()]),
});

const providerTable = "postgres_fitness.provider";
const replacementTable = "postgres_fitness.provider_catalog_next";
const backupTable = "postgres_fitness.provider_before_catalog_migration";
const providerColumns = [
  "id",
  "name",
  "api_base_url",
  "user_id",
  "created_at",
  "_peerdb_synced_at",
  "_peerdb_is_deleted",
  "_peerdb_version",
].join(", ");

const providerConnectionStatement = buildPostgresFitnessProviderConnectionRawTableStatement();

export function createMigration(): ClickHouseMigration {
  return {
    id: "0055_provider_connection_catalog",
    statements: [buildPostgresFitnessProviderRawTableStatement(), providerConnectionStatement],
    run: migrateProviderConnectionCatalog,
  };
}

async function migrateProviderConnectionCatalog(
  client: ClickHouseCommandClient,
  _postgresConnectionString: string,
): Promise<void> {
  await recoverInterruptedProviderRebuild(client);

  if (!(await tableExists(client, "provider"))) {
    await runClickHouseMigrationStatement(client, buildPostgresFitnessProviderRawTableStatement());
  } else if (await providerRequiresRebuild(client)) {
    await rebuildProviderTable(client);
  }

  await runClickHouseMigrationStatement(client, providerConnectionStatement);
}

async function recoverInterruptedProviderRebuild(client: ClickHouseCommandClient): Promise<void> {
  if (!(await tableExists(client, "provider_before_catalog_migration"))) {
    return;
  }
  if (!(await tableExists(client, "provider"))) {
    await runClickHouseMigrationStatement(
      client,
      `RENAME TABLE ${backupTable} TO ${providerTable}`,
    );
    return;
  }

  await runClickHouseMigrationStatement(
    client,
    `INSERT INTO ${providerTable} (${providerColumns})
     SELECT ${providerColumns} FROM ${backupTable}`,
  );
  await runClickHouseMigrationStatement(client, `DROP TABLE IF EXISTS ${backupTable}`);
}

async function providerRequiresRebuild(client: ClickHouseCommandClient): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }
  const result = await client.query({
    query: `SELECT type, is_in_sorting_key
      FROM system.columns
      WHERE database = 'postgres_fitness'
        AND table = 'provider'
        AND name = 'user_id'`,
    format: "JSONEachRow",
  });
  const rows = z.array(providerColumnRowSchema).parse(await result.json());
  const row = rows[0];
  if (!row) {
    throw new Error("postgres_fitness.provider is missing required user_id column");
  }
  return row.type !== "Nullable(UUID)" || Number(row.is_in_sorting_key) !== 0;
}

async function rebuildProviderTable(client: ClickHouseCommandClient): Promise<void> {
  const statements = [
    `DROP TABLE IF EXISTS ${replacementTable}`,
    buildPostgresFitnessProviderRawTableStatement({
      tableName: replacementTable,
      ifNotExists: false,
    }),
    `INSERT INTO ${replacementTable} (${providerColumns})
     SELECT ${providerColumns} FROM ${providerTable}`,
    `DROP TABLE IF EXISTS ${backupTable}`,
    `RENAME TABLE ${providerTable} TO ${backupTable}, ${replacementTable} TO ${providerTable}`,
    `INSERT INTO ${providerTable} (${providerColumns})
     SELECT ${providerColumns} FROM ${backupTable}`,
    `DROP TABLE IF EXISTS ${backupTable}`,
  ];
  for (const statement of statements) {
    await runClickHouseMigrationStatement(client, statement);
  }
}

async function tableExists(client: ClickHouseCommandClient, tableName: string): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }
  const result = await client.query({
    query: `SELECT count() AS table_count
      FROM system.tables
      WHERE database = 'postgres_fitness'
        AND name = {tableName:String}`,
    query_params: { tableName },
    format: "JSONEachRow",
  });
  const rows = z.array(tableCountRowSchema).parse(await result.json());
  return Number(rows[0]?.table_count ?? 0) > 0;
}
