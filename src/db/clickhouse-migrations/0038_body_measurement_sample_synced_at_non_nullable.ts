import { z } from "zod";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";
import type { ClickHouseMigration } from "./types.ts";

interface ColumnTypeRow {
  type: string;
}

const columnTypeRowSchema = z.object({
  type: z.string(),
});

const statements = [
  "ALTER TABLE analytics.body_measurement_sample MODIFY COLUMN _peerdb_synced_at DateTime64(9) DEFAULT now()",
];

export function createMigration(): ClickHouseMigration {
  return {
    id: "0038_body_measurement_sample_synced_at_non_nullable",
    statements,
    run: async (client) => {
      if (!(await tableExists(client))) {
        return;
      }

      await backfillNullSyncedAt(client);
      await tightenColumnToNonNullable(client);
    },
  };
}

async function tableExists(client: ClickHouseCommandClient): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }
  const result = await client.query<{ count: string | number }>({
    query:
      "SELECT count() AS count FROM system.tables WHERE database = 'analytics' AND name = 'body_measurement_sample'",
    format: "JSONEachRow",
  });
  const rows = await result.json();
  return rows.length > 0 && Number(rows[0]?.count ?? 0) > 0;
}

async function backfillNullSyncedAt(client: ClickHouseCommandClient): Promise<void> {
  await client.command({
    query:
      "ALTER TABLE analytics.body_measurement_sample UPDATE _peerdb_synced_at = recorded_at WHERE _peerdb_synced_at IS NULL",
    clickhouse_settings: { mutations_sync: 2 },
  });
}

async function tightenColumnToNonNullable(client: ClickHouseCommandClient): Promise<void> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }

  const currentType = await fetchCurrentColumnType(client);
  const targetType = "DateTime64(9)";
  if (currentType === targetType) {
    return;
  }

  for (const statement of statements) {
    await runClickHouseMigrationStatement(client, statement);
  }
}

async function fetchCurrentColumnType(
  client: ClickHouseCommandClient,
): Promise<string | undefined> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }
  const result = await client.query<ColumnTypeRow>({
    query:
      "SELECT type FROM system.columns WHERE database = 'analytics' AND table = 'body_measurement_sample' AND name = '_peerdb_synced_at'",
    format: "JSONEachRow",
  });
  const rows = await result.json();
  if (!rows[0]) {
    return undefined;
  }
  return columnTypeRowSchema.parse(rows[0]).type;
}
