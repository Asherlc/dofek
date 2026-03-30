import { createHash } from "node:crypto";
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

/** Compute a SHA-256 hex digest of migration file content. */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
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
 * views from their canonical definitions in drizzle/_views/.
 *
 * Safe to call on every startup — skips already-applied migrations.
 * Uses a Postgres advisory lock to prevent races when multiple containers start simultaneously.
 *
 * Materialized views (v_activity, activity_summary) are always recreated from
 * canonical SQL files in drizzle/_views/ rather than being managed by migrations.
 * This prevents conflicts when concurrent PRs both need to change a view —
 * they edit the same file, creating a Git merge conflict that must be resolved.
 */
export async function runMigrations(databaseUrl: string, migrationsDir?: string): Promise<number> {
  const dir = migrationsDir ?? resolve(import.meta.dirname, "../../drizzle");
  const viewsDir = join(dir, "_views");
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

    // Add content_hash column for tamper detection (idempotent for existing DBs)
    await sql`ALTER TABLE drizzle.__drizzle_migrations
      ADD COLUMN IF NOT EXISTS content_hash TEXT`;

    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied = await sql`SELECT hash, content_hash FROM drizzle.__drizzle_migrations`;
    const appliedSet = new Set(applied.map((r) => r.hash));

    // Detect in-place edits to already-applied migration files
    for (const row of applied) {
      if (!row.content_hash) continue;
      const filePath = join(dir, row.hash);
      if (!existsSync(filePath)) continue;
      const currentContent = readFileSync(filePath, "utf-8");
      const currentHash = computeContentHash(currentContent);
      if (currentHash !== row.content_hash) {
        logger.warn(
          `[migrate] ${row.hash} has been modified since it was applied. ` +
            "Editing applied migrations has no effect — write a new migration instead.",
        );
      }
    }

    const pendingFiles = files.filter((f) => !appliedSet.has(f));

    // Detect duplicate prefixes among pending migrations — two migrations
    // sharing a number means concurrent PRs created conflicting migrations.
    // Log a warning rather than throwing, since historical duplicates exist
    // (0018, 0022, 0023, 0024, 0041) and would block fresh-DB migrations.
    const duplicates = detectDuplicatePrefixes(pendingFiles);
    if (duplicates.length > 0) {
      const details = duplicates
        .map(([prefix, group]) => `  ${prefix}: ${group.join(", ")}`)
        .join("\n");
      logger.warn(
        `[migrate] Duplicate migration prefixes detected — consider reconciling:\n${details}`,
      );
    }

    let count = 0;
    for (const file of pendingFiles) {
      logger.info(`[migrate] Applying: ${file}`);
      const content = readFileSync(join(dir, file), "utf-8");
      const contentHash = computeContentHash(content);
      for (const stmt of parseStatements(content)) {
        await sql.unsafe(stmt);
      }
      await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at, content_hash) VALUES (${file}, ${Date.now()}, ${contentHash})`;
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
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch((error: unknown) => {
      logger.warn("Advisory unlock failed: %s", error);
    });
    await sql.end();
  }
}

/**
 * Drop and recreate materialized views from canonical SQL files in drizzle/_views/.
 * Files are named with numeric prefixes for dependency ordering (e.g., 01_v_activity.sql
 * before 02_activity_summary.sql). All existing materialized views in the fitness schema
 * are dropped before recreation to avoid dependency issues.
 */
async function recreateViews(sql: postgres.Sql, viewsDir: string): Promise<void> {
  const viewFiles = readdirSync(viewsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (viewFiles.length === 0) return;

  logger.info(`[migrate] Recreating ${viewFiles.length} materialized view(s)`);

  // Parse view files upfront so we know which views to drop.
  // Only views with canonical definitions in _views/ are dropped and recreated —
  // other materialized views (e.g. v_daily_metrics, v_sleep) are left untouched.
  const parsedViews = viewFiles.map((file) => {
    const content = readFileSync(join(viewsDir, file), "utf-8");
    const match = content.match(/CREATE\s+MATERIALIZED\s+VIEW\s+fitness\.(\w+)/i);
    return { file, content, viewName: match?.[1] };
  });

  // Drop managed views in reverse order (dependents first)
  for (const { viewName } of [...parsedViews].reverse()) {
    if (!viewName) continue;
    logger.info(`[migrate] Dropping fitness.${viewName}`);
    await sql.unsafe(`DROP MATERIALIZED VIEW IF EXISTS fitness.${viewName} CASCADE`);
  }

  // Create in filename order (01_v_activity before 02_activity_summary)
  for (const { file, content } of parsedViews) {
    logger.info(`[migrate] Creating from ${file}`);
    for (const stmt of parseStatements(content)) {
      await sql.unsafe(stmt);
    }
  }

  logger.info("[migrate] Materialized views recreated");
}
