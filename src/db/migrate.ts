import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { z } from "zod";
import {
  assertPostgresAccountErasureCoverage,
  refreshPostgresAccountErasureWriteFences,
} from "../account-erasure/postgres-erasure.ts";
import { logger } from "../logger.ts";
import { readBaselineMigration, runDrizzleMigrations } from "./postgres-migrator.ts";
import { executeWithSchema } from "./typed-sql.ts";

/** Postgres advisory lock key — serializes concurrent migration runs across containers */
export const MIGRATION_LOCK_KEY = 728370291;

const migrationCountRowsSchema = z.array(z.object({ count: z.coerce.number().int() }));
const schemaHasTablesRowsSchema = z.array(z.object({ has_tables: z.boolean() }));
const accountErasureCoverageHookRowSchema = z.object({ installed: z.boolean() });

async function getMigrationCount(client: Client): Promise<number> {
  const result = await client.query("SELECT count(*) AS count FROM drizzle.__drizzle_migrations");
  return migrationCountRowsSchema.parse(result.rows)[0]?.count ?? 0;
}

/**
 * Run pending migrations from the drizzle/ directory.
 *
 * Safe to call on every startup — skips already-applied migrations.
 * Uses a Postgres advisory lock to prevent races when multiple containers start simultaneously.
 */
export async function runMigrations(databaseUrl: string, migrationsDir?: string): Promise<number> {
  const dir = migrationsDir ?? resolve(import.meta.dirname, "../../drizzle");
  const client = new Client({ connectionString: databaseUrl });
  let lockAcquired = false;

  try {
    logger.info("[migrate] Connecting to Postgres");
    await client.connect();
    logger.info("[migrate] Waiting for Postgres migration advisory lock");
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    lockAcquired = true;
    logger.info("[migrate] Acquired Postgres migration advisory lock");

    await client.query("CREATE SCHEMA IF NOT EXISTS health");
    await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");

    await client.query(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT
    )`);

    // Baseline migrations are for fresh databases only. Skip them if any
    // migration has already been applied OR if the target schema already has
    // tables (handles the case where migration tracking was reset but the
    // DB still has data — e.g., after a migration squash rollout).
    const appliedCount = await getMigrationCount(client);
    const schemaHasTablesResult = await client.query(`SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'fitness' AND table_type = 'BASE TABLE'
      ) AS has_tables`);
    const schemaHasTables =
      schemaHasTablesRowsSchema.parse(schemaHasTablesResult.rows)[0]?.has_tables === true;

    if (appliedCount === 0 && schemaHasTables) {
      const baselineMigration = readBaselineMigration(dir);
      if (!baselineMigration) {
        if (!migrationsDir) {
          throw new Error("Postgres baseline migration is required for an existing database");
        }
      } else {
        logger.info("[migrate] Marking baseline migration as applied on existing database");
        await client.query(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
           VALUES ($1, $2)`,
          [baselineMigration.hash, baselineMigration.folderMillis],
        );
      }
    }

    const countBeforeMigrate = await getMigrationCount(client);
    await runDrizzleMigrations(client, dir);
    const count = (await getMigrationCount(client)) - countBeforeMigrate;

    const database = drizzle(client);
    const coverageHookRows = await executeWithSchema(
      database,
      accountErasureCoverageHookRowSchema,
      sql`SELECT to_regprocedure(
            'fitness.refresh_account_erasure_write_fences()'
          ) IS NOT NULL AS installed`,
    );
    const coverageHookInstalled = coverageHookRows[0]?.installed === true;
    if (coverageHookInstalled) {
      await refreshPostgresAccountErasureWriteFences(database);
      await assertPostgresAccountErasureCoverage(database);
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
