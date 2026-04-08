import postgres from "postgres";
import { logger } from "../logger.ts";

/**
 * Upgrade the TimescaleDB extension to the version shipped with the container image.
 *
 * When the Docker image is updated (e.g., 2.26.1 → 2.26.2), the new shared
 * libraries are on disk but the database catalog still references the old version.
 * `ALTER EXTENSION timescaledb UPDATE` bridges that gap. It's a no-op when the
 * extension is already at the latest available version.
 */
export async function upgradeTimescaleDb(databaseUrl: string): Promise<void> {
  const sql = postgres(databaseUrl);
  try {
    const before = await sql`SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'`;
    const previousVersion = before[0]?.extversion;
    if (!previousVersion) {
      logger.info("[timescaledb] Extension not installed, skipping upgrade");
      return;
    }

    await sql`ALTER EXTENSION timescaledb UPDATE`;

    const after = await sql`SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'`;
    const currentVersion = after[0]?.extversion;

    if (currentVersion !== previousVersion) {
      logger.info(`[timescaledb] Upgraded extension: ${previousVersion} → ${currentVersion}`);
    } else {
      logger.info(`[timescaledb] Extension already at ${currentVersion}`);
    }
  } finally {
    await sql.end();
  }
}
