import { logger } from "../logger.ts";
import type { ClickHouseCommandClient } from "./clickhouse.ts";
import { clickHouseMigrations } from "./clickhouse-migrations/registry.ts";
import { clickHouseStringLiteral } from "./clickhouse-migrations/sql.ts";
import { runClickHouseMigrationStatement } from "./clickhouse-migrations/statement-runner.ts";

interface MigrationCountRow {
  migration_count: number | string;
}

export async function runClickHouseMigrations(
  client: ClickHouseCommandClient,
  postgresConnectionString: string,
): Promise<number> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }

  await client.command({ query: "CREATE DATABASE IF NOT EXISTS analytics" });
  await client.command({ query: "CREATE DATABASE IF NOT EXISTS fitness" });
  await client.command({
    query: `CREATE TABLE IF NOT EXISTS analytics.schema_migrations (
  id String,
  applied_at DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY id`,
  });

  let appliedCount = 0;
  const initiallyAppliedMigrationIds = new Set<string>();
  for (const migration of clickHouseMigrations(postgresConnectionString)) {
    const migrationId = clickHouseStringLiteral(migration.id);
    const result = await client.query<MigrationCountRow>({
      query: `SELECT count() AS migration_count FROM analytics.schema_migrations WHERE id = ${migrationId}`,
      format: "JSONEachRow",
    });
    const rows = await result.json();
    const wasAppliedBeforeThisRun = Number(rows[0]?.migration_count ?? 0) > 0;
    if (wasAppliedBeforeThisRun) {
      initiallyAppliedMigrationIds.add(migration.id);
      continue;
    }

    logger.info(`[migrate] Applying ClickHouse migration: ${migration.id}`);
    if (
      migration.requiresPreviouslyAppliedMigrationId &&
      !initiallyAppliedMigrationIds.has(migration.requiresPreviouslyAppliedMigrationId)
    ) {
      logger.info(
        `[migrate] Skipping ClickHouse migration body: ${migration.id} requires ${migration.requiresPreviouslyAppliedMigrationId} to have been applied before this run`,
      );
    } else if (migration.run) {
      await migration.run(client, postgresConnectionString);
    } else {
      for (const statement of migration.statements) {
        await runClickHouseMigrationStatement(client, statement);
      }
    }
    await client.command({
      query: `INSERT INTO analytics.schema_migrations (id) VALUES (${migrationId})`,
    });
    logger.info(`[migrate] Applied ClickHouse migration: ${migration.id}`);
    appliedCount += 1;
  }

  return appliedCount;
}
