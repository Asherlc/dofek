import { logger } from "../logger.ts";
import { createClickHouseClientFromEnv } from "./clickhouse.ts";
import { runClickHouseMigrations } from "./clickhouse-migrations.ts";
import { runMigrations } from "./migrate.ts";

const CLICKHOUSE_MIGRATION_REQUEST_TIMEOUT_MS = 3_300_000;

export async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  const clickHouseUrl = process.env.CLICKHOUSE_URL;
  if (!clickHouseUrl) {
    throw new Error("CLICKHOUSE_URL environment variable is required");
  }

  logger.info("[migrate] Starting Postgres migrations");
  const count = await runMigrations(databaseUrl);
  logger.info(`[migrate] Postgres migrations complete — ${count} migration(s) applied`);

  logger.info("[migrate] Starting ClickHouse migrations");
  const clickHouseClient = createClickHouseClientFromEnv(process.env, {
    requestTimeoutMs: CLICKHOUSE_MIGRATION_REQUEST_TIMEOUT_MS,
  });
  try {
    const clickHouseCount = await runClickHouseMigrations(clickHouseClient, databaseUrl);
    logger.info(
      `[migrate] ClickHouse migrations complete — ${clickHouseCount} migration(s) applied`,
    );
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
