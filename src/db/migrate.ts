import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { logger } from "../logger.ts";

/** Postgres advisory lock key — serializes concurrent migration runs across containers */
export const MIGRATION_LOCK_KEY = 728370291;

/**
 * Run pending migrations from the drizzle/ directory.
 * Safe to call on every startup — skips already-applied migrations.
 * Uses a Postgres advisory lock to prevent races when multiple containers start simultaneously.
 */
export async function runMigrations(databaseUrl: string, migrationsDir?: string): Promise<number> {
  const dir = migrationsDir ?? resolve(import.meta.dirname, "../../drizzle");
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

    let count = 0;
    for (const file of files) {
      if (appliedSet.has(file)) continue;
      logger.info(`[migrate] Applying: ${file}`);
      const content = readFileSync(join(dir, file), "utf-8");
      const statements = content
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of statements) {
        await sql.unsafe(stmt);
      }
      await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${file}, ${Date.now()})`;
      count++;
    }

    if (count > 0) {
      logger.info(`[migrate] Applied ${count} migration(s)`);
    }
    return count;
  } finally {
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch(() => {});
    await sql.end();
  }
}
