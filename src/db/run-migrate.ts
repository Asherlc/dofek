import { logger } from "../logger.ts";
import { createClickHouseClientFromEnv } from "./clickhouse.ts";
import { runClickHouseMigrations } from "./clickhouse-migrations.ts";
import { runMigrations } from "./migrate.ts";
import { syncMaterializedViews } from "./sync-views.ts";

export async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  const clickHouseUrl = process.env.CLICKHOUSE_URL;
  if (!clickHouseUrl) {
    throw new Error("CLICKHOUSE_URL environment variable is required");
  }

  const count = await runMigrations(databaseUrl);
  logger.info(`[migrate] Done — ${count} migration(s) applied`);
  const viewResult = await syncMaterializedViews(databaseUrl);
  logger.info(
    `[migrate] Materialized views synced=${viewResult.synced} skipped=${viewResult.skipped} refreshed=${viewResult.refreshed}`,
  );

  const clickHouseClient = createClickHouseClientFromEnv();
  try {
    const clickHouseCount = await runClickHouseMigrations(clickHouseClient, databaseUrl);
    logger.info(`[migrate] Done — ${clickHouseCount} ClickHouse migration(s) applied`);
  } finally {
    await clickHouseClient.close?.();
  }
}

// Only run when executed directly (not imported for testing)
const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isDirectRun) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error(`[migrate] ${error}`);
      process.exit(1);
    });
}
