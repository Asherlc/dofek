import { logger } from "../logger.ts";
import { runMigrations } from "./migrate.ts";
import { syncMaterializedViews } from "./sync-views.ts";

export async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const count = await runMigrations(databaseUrl);
  logger.info(`[migrate] Done — ${count} migration(s) applied`);

  // Sync materialized view definitions (only recreates views whose SQL changed)
  const { synced, skipped, refreshed } = await syncMaterializedViews(databaseUrl);
  logger.info(
    `[views] Done — ${synced} recreated, ${skipped} unchanged` +
      (refreshed > 0 ? `, ${refreshed} refreshed (were unpopulated)` : ""),
  );
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
