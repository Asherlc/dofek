import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";
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

function isBaselineMigration(file: string): boolean {
  return /^\d+_baseline(?:_.*)?\.sql$/.test(file);
}

/** Parse SQL file into individual statements, split on `--> statement-breakpoint`. */
function parseStatements(content: string): Array<string> {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/**
 * Run pending migrations from the drizzle/ directory.
 *
 * Safe to call on every startup — skips already-applied migrations.
 * Uses a Postgres advisory lock to prevent races when multiple containers start simultaneously.
 *
 * Materialized view synchronization is handled separately by `syncMaterializedViews()`
 * in `sync-views.ts`, which only recreates views whose definitions have changed.
 * This avoids the multi-minute downtime window that unconditional view recreation causes
 * when the API server is already serving traffic during background migrations.
 */
export async function runMigrations(databaseUrl: string, migrationsDir?: string): Promise<number> {
  const dir = migrationsDir ?? resolve(import.meta.dirname, "../../drizzle");
  const client = new Client({ connectionString: databaseUrl });
  let lockAcquired = false;

  try {
    await client.connect();
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    lockAcquired = true;

    await client.query("CREATE SCHEMA IF NOT EXISTS health");
    await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");

    await client.query(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT
    )`);

    // Add content_hash column for tamper detection (idempotent for existing DBs)
    await client.query(`ALTER TABLE drizzle.__drizzle_migrations
      ADD COLUMN IF NOT EXISTS content_hash TEXT`);

    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const appliedResult = await client.query<{ hash: string; content_hash: string | null }>(
      "SELECT hash, content_hash FROM drizzle.__drizzle_migrations",
    );
    const applied = appliedResult.rows;
    const appliedSet = new Set(applied.map((row) => row.hash));

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

    let pendingFiles = files.filter((f) => !appliedSet.has(f));

    // Baseline migrations are for fresh databases only. Skip them if any
    // migration has already been applied OR if the target schema already has
    // tables (handles the case where migration tracking was reset but the
    // DB still has data — e.g., after a migration squash rollout).
    const schemaHasTables =
      (
        await client.query<{ has_tables: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'fitness' AND table_type = 'BASE TABLE'
      ) AS has_tables`)
      ).rows[0]?.has_tables === true;

    if (appliedSet.size > 0 || schemaHasTables) {
      const pendingBaselines = pendingFiles.filter(isBaselineMigration);
      for (const file of pendingBaselines) {
        const content = readFileSync(join(dir, file), "utf-8");
        const contentHash = computeContentHash(content);
        logger.info(
          `[migrate] Marking baseline migration as applied on existing database: ${file}`,
        );
        await client.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at, content_hash) VALUES ($1, $2, $3)",
          [file, Date.now(), contentHash],
        );
        appliedSet.add(file);
      }
      pendingFiles = files.filter((f) => !appliedSet.has(f));
    }

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
        await client.query(stmt);
      }
      await client.query(
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at, content_hash) VALUES ($1, $2, $3)",
        [file, Date.now(), contentHash],
      );
      count++;
    }

    if (count > 0) {
      logger.info(`[migrate] Applied ${count} migration(s)`);
    }

    return count;
  } finally {
    if (lockAcquired) {
      await client
        .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
        .catch((error: unknown) => {
          logger.warn("Advisory unlock failed: %s", error);
        });
    }
    await client.end().catch((error: unknown) => {
      logger.warn("Migration client shutdown failed: %s", error);
    });
  }
}
