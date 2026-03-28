import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { logger } from "../logger.ts";

/** Postgres advisory lock key — serializes concurrent migration runs across containers */
export const MIGRATION_LOCK_KEY = 728370291;

/**
 * Detect migration files that share the same numeric prefix (e.g., two 0049_* files).
 * This indicates concurrent PRs created conflicting migrations that must be reconciled.
 */
export function detectDuplicatePrefixes(files: Array<string>): Array<[string, Array<string>]> {
  const byPrefix = new Map<string, Array<string>>();
  for (const file of files) {
    const match = file.match(/^(\d+)_/);
    if (!match) continue;
    const prefix = match[1] ?? "";
    const group = byPrefix.get(prefix);
    if (group) {
      group.push(file);
    } else {
      byPrefix.set(prefix, [file]);
    }
  }
  return [...byPrefix.entries()].filter(([, group]) => group.length > 1);
}

/** Parse SQL file into individual statements, split on `--> statement-breakpoint`. */
function parseStatements(content: string): Array<string> {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/**
 * Run pending migrations from the drizzle/ directory, then recreate materialized
 * views from their canonical definitions in drizzle/views/.
 *
 * Safe to call on every startup — skips already-applied migrations.
 * Uses a Postgres advisory lock to prevent races when multiple containers start simultaneously.
 *
 * Materialized views (v_activity, activity_summary) are always recreated from
 * canonical SQL files in drizzle/views/ rather than being managed by migrations.
 * This prevents conflicts when concurrent PRs both need to change a view —
 * they edit the same file, creating a Git merge conflict that must be resolved.
 */
export async function runMigrations(databaseUrl: string, migrationsDir?: string): Promise<number> {
  const dir = migrationsDir ?? resolve(import.meta.dirname, "../../drizzle");
  const viewsDir = join(dir, "views");
  const sql = postgres(databaseUrl);

  try {
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;

    await sql`CREATE SCHEMA IF NOT EXISTS health`;
    await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;

    await sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT
    )`;

    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied = await sql`SELECT hash FROM drizzle.__drizzle_migrations`;
    const appliedSet = new Set(applied.map((r) => r.hash));

    const pendingFiles = files.filter((f) => !appliedSet.has(f));

    // Detect duplicate prefixes among pending migrations — two migrations
    // sharing a number means concurrent PRs created conflicting migrations.
    const duplicates = detectDuplicatePrefixes(pendingFiles);
    if (duplicates.length > 0) {
      const details = duplicates
        .map(([prefix, group]) => `  ${prefix}: ${group.join(", ")}`)
        .join("\n");
      throw new Error(
        `Duplicate migration prefixes detected — these must be reconciled:\n${details}`,
      );
    }

    let count = 0;
    for (const file of pendingFiles) {
      logger.info(`[migrate] Applying: ${file}`);
      const content = readFileSync(join(dir, file), "utf-8");
      for (const stmt of parseStatements(content)) {
        await sql.unsafe(stmt);
      }
      await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${file}, ${Date.now()})`;
      count++;
    }

    if (count > 0) {
      logger.info(`[migrate] Applied ${count} migration(s)`);
    }

    // Recreate materialized views from canonical definitions.
    // Views are always dropped and recreated to ensure they match
    // the canonical SQL — this is safe because views contain no unique data.
    if (existsSync(viewsDir)) {
      await recreateViews(sql, viewsDir);
    }

    return count;
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch(() => {});
    await sql.end();
  }
}

/**
 * Drop and recreate materialized views from canonical SQL files in drizzle/views/.
 * Files are applied in alphabetical order (v_activity before activity_summary)
 * to respect dependency ordering.
 */
async function recreateViews(sql: postgres.Sql, viewsDir: string): Promise<void> {
  const viewFiles = readdirSync(viewsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (viewFiles.length === 0) return;

  logger.info(`[migrate] Recreating ${viewFiles.length} materialized view(s)`);

  // Drop in reverse order (activity_summary depends on v_activity)
  for (const file of [...viewFiles].reverse()) {
    const viewName = file.replace(/\.sql$/, "");
    logger.info(`[migrate] Dropping fitness.${viewName}`);
    await sql.unsafe(`DROP MATERIALIZED VIEW IF EXISTS fitness.${viewName} CASCADE`);
  }

  // Create in alphabetical order (v_activity first, then activity_summary)
  for (const file of viewFiles) {
    logger.info(`[migrate] Creating fitness.${file.replace(/\.sql$/, "")}`);
    const content = readFileSync(join(viewsDir, file), "utf-8");
    for (const stmt of parseStatements(content)) {
      await sql.unsafe(stmt);
    }
  }

  logger.info("[migrate] Materialized views recreated");
}
