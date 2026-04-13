import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { logger } from "../logger.ts";

/** Postgres advisory lock key — serializes concurrent view sync runs across containers */
export const VIEW_SYNC_LOCK_KEY = 728370292;

/**
 * Extract the view name from a CREATE MATERIALIZED VIEW statement.
 * Handles both "CREATE MATERIALIZED VIEW" and "CREATE MATERIALIZED VIEW IF NOT EXISTS".
 */
export function extractViewName(sqlContent: string): string | null {
  const match = sqlContent.match(/CREATE\s+MATERIALIZED\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)/i);
  return match?.[1] ?? null;
}

/**
 * Compute a SHA-256 hash of the SQL content, ignoring leading comments and whitespace
 * so that comment-only changes don't trigger expensive view recreation.
 */
export function hashViewContent(sqlContent: string): string {
  // Strip leading SQL comments and blank lines, then normalize whitespace
  const normalized = sqlContent
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--") || line.includes("statement-breakpoint"))
    .join("\n")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Check whether a materialized view exists in the PostgreSQL catalog.
 * Returns true if the view is present (regardless of whether it's populated).
 * This catches views that were CASCADE-dropped when a dependency was recreated.
 */
export async function viewExistsInCatalog(
  sql: ReturnType<typeof postgres>,
  viewName: string,
): Promise<boolean> {
  const dotIndex = viewName.indexOf(".");
  const schema = dotIndex >= 0 ? viewName.slice(0, dotIndex) : "public";
  const name = dotIndex >= 0 ? viewName.slice(dotIndex + 1) : viewName;
  const rows =
    await sql`SELECT 1 FROM pg_matviews WHERE schemaname = ${schema} AND matviewname = ${name}`;
  return rows.length > 0;
}

/**
 * Check whether a materialized view has been populated (has data loaded).
 * A view created with WITH NO DATA, or one whose population was interrupted
 * by a crash, will report `ispopulated = false` in pg_matviews. // cspell:disable-line
 */
export async function isViewPopulated(
  sql: ReturnType<typeof postgres>,
  viewName: string,
): Promise<boolean> {
  const dotIndex = viewName.indexOf(".");
  const schema = dotIndex >= 0 ? viewName.slice(0, dotIndex) : "public";
  const name = dotIndex >= 0 ? viewName.slice(dotIndex + 1) : viewName;
  const rows =
    // cspell:disable-next-line -- Postgres system catalog column name
    await sql`SELECT ispopulated AS populated FROM pg_matviews WHERE schemaname = ${schema} AND matviewname = ${name}`;
  // If the view doesn't exist in pg_matviews, treat as not populated
  return rows[0]?.populated === true;
}

/**
 * Synchronize materialized view definitions from drizzle/_views/ SQL files.
 *
 * For each view file:
 * 1. Compute a SHA-256 hash of the SQL content
 * 2. Compare against the stored hash in drizzle.__view_hashes
 * 3. Only drop and recreate the view if the hash has changed
 * 4. After processing all views, refresh any that exist but are unpopulated
 *    (can happen after a Postgres crash during recovery)
 *
 * This avoids the 2+ minute downtime caused by unconditionally
 * dropping and recreating all materialized views on every deploy.
 */
export async function syncMaterializedViews(
  databaseUrl: string,
  viewsDir?: string,
): Promise<{ synced: number; skipped: number; refreshed: number }> {
  const dir = viewsDir ?? resolve(import.meta.dirname, "../../drizzle/_views");
  const files = readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    return { synced: 0, skipped: 0, refreshed: 0 };
  }

  // Single connection — advisory locks are session-scoped, so the lock, all DDL,
  // and the unlock must run on the same connection. A pool would scatter queries
  // across connections, making the lock ineffective.
  const sql = postgres(databaseUrl, { max: 1 });
  let lockAcquired = false;

  try {
    // Serialize view sync across containers — prevents two containers from
    // racing to DROP/CREATE the same materialized view simultaneously.
    await sql`SELECT pg_advisory_lock(${VIEW_SYNC_LOCK_KEY})`;
    lockAcquired = true;

    // Ensure tracking table exists
    await sql`CREATE TABLE IF NOT EXISTS drizzle.__view_hashes (
      view_name TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )`;

    let synced = 0;
    let skipped = 0;
    const allViewNames: string[] = [];
    const failedViews: Array<{ viewName: string; error: unknown }> = [];

    for (const file of files) {
      const content = readFileSync(join(dir, file), "utf-8");
      const hash = hashViewContent(content);
      const viewName = extractViewName(content);

      if (!viewName) {
        logger.warn(`[views] Could not extract view name from ${file}, skipping`);
        continue;
      }

      allViewNames.push(viewName);

      // Check if this view's definition has changed
      const existing =
        await sql`SELECT hash FROM drizzle.__view_hashes WHERE view_name = ${viewName}`;
      const storedHash = existing[0]?.hash;
      if (storedHash === hash) {
        // Verify the view still exists — it may have been CASCADE-dropped
        // when a dependency was recreated.
        const exists = await viewExistsInCatalog(sql, viewName);
        if (exists) {
          logger.info(`[views] ${viewName} unchanged, skipping`);
          skipped++;
          continue;
        }
        logger.warn(
          `[views] ${viewName} hash matches but view is missing (CASCADE-dropped?), recreating`,
        );
      }

      // View definition changed (or new) — drop and recreate
      try {
        logger.info(`[views] ${viewName} changed, recreating`);
        await sql.unsafe(`DROP MATERIALIZED VIEW IF EXISTS ${viewName} CASCADE`);

        const statements = content
          .split("--> statement-breakpoint")
          .map((statement) => statement.trim())
          .filter(Boolean);
        for (const statement of statements) {
          await sql.unsafe(statement);
        }

        // Record the hash
        await sql`
          INSERT INTO drizzle.__view_hashes (view_name, hash, applied_at)
          VALUES (${viewName}, ${hash}, NOW())
          ON CONFLICT (view_name) DO UPDATE SET hash = ${hash}, applied_at = NOW()
        `;
        synced++;
      } catch (error) {
        logger.error(`[views] Failed to recreate ${viewName}: ${error}`);
        failedViews.push({ viewName, error });
      }
    }

    // Refresh any views that exist but are unpopulated (e.g., after a Postgres crash
    // that interrupted view population, leaving them marked as not populated in pg_matviews).
    let refreshed = 0;
    for (const viewName of allViewNames) {
      const populated = await isViewPopulated(sql, viewName);
      if (!populated) {
        const exists = await viewExistsInCatalog(sql, viewName);
        if (!exists) {
          // View doesn't exist (failed creation earlier) — skip refresh
          continue;
        }
        logger.warn(`[views] ${viewName} exists but is not populated, refreshing`);
        await sql.unsafe(`REFRESH MATERIALIZED VIEW ${viewName}`);
        refreshed++;
      }
    }

    if (failedViews.length > 0) {
      const names = failedViews.map(({ viewName }) => viewName).join(", ");
      throw new AggregateError(
        failedViews.map(({ error }) => error),
        `Failed to recreate ${failedViews.length} view(s): ${names}`,
      );
    }

    return { synced, skipped, refreshed };
  } finally {
    if (lockAcquired) {
      await sql`SELECT pg_advisory_unlock(${VIEW_SYNC_LOCK_KEY})`.catch((error: unknown) => {
        logger.warn("View sync advisory unlock failed: %s", error);
      });
    }
    await sql.end();
  }
}
