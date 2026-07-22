import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runMigrations } from "./migrate.ts";
import { setupTestDatabase, type TestContext, writeTestMigrationFiles } from "./test-helpers.ts";

// cspell:ignore pkey relkind relname relnamespace relreplident nspname

const tableNameRowsSchema = z.array(z.object({ table_name: z.string() }));
const relationExistsRowsSchema = z.array(z.object({ relation_exists: z.boolean() }));
const nullableRowsSchema = z.array(z.object({ is_nullable: z.enum(["YES", "NO"]) }));
const primaryKeyRowsSchema = z.array(z.object({ columns: z.string() }));
const migrationRollbackRowsSchema = z.array(
  z.object({
    migration_record_exists: z.boolean(),
    relation_exists: z.boolean(),
  }),
);
let nextMigrationTimestamp = 2_000_000_000_000;

function writeTestMigration(migrationsDir: string, file: string, content: string): void {
  writeTestMigrationFiles(migrationsDir, [{ content, file, when: nextMigrationTimestamp++ }]);
}

describe("runMigrations", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it("runs migrations successfully and returns count", async () => {
    // Create a fresh database for this test (the test helper already ran migrations,
    // so we test with a temporary migrations directory containing a single migration)
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-"));
    writeTestMigration(
      tmpDir,
      "0001_test.sql",
      "CREATE TABLE IF NOT EXISTS fitness.migrate_test (id serial PRIMARY KEY, name text);",
    );

    const count = await runMigrations(ctx.connectionString, tmpDir);
    expect(count).toBe(1);

    // Verify the table was created
    const client = new Client({ connectionString: ctx.connectionString });
    await client.connect();
    const result = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'fitness' AND table_name = 'migrate_test'`,
    );
    expect(tableNameRowsSchema.parse(result.rows).length).toBe(1);
    await client.end();
  });

  it("skips already-applied migrations on second run", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-idempotent-"));
    writeTestMigration(
      tmpDir,
      "0001_test_idempotent.sql",
      "CREATE TABLE IF NOT EXISTS fitness.migrate_idempotent_test (id serial PRIMARY KEY);",
    );

    const firstCount = await runMigrations(ctx.connectionString, tmpDir);
    expect(firstCount).toBe(1);

    const secondCount = await runMigrations(ctx.connectionString, tmpDir);
    expect(secondCount).toBe(0);
  });

  it("continues after migrations recorded by the legacy filename tracker", async () => {
    const client = new Client({ connectionString: ctx.connectionString });
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-legacy-history-"));
    const firstMigration = {
      content: "CREATE TABLE fitness.legacy_history_first (id integer PRIMARY KEY);",
      file: "0001_legacy_history_first.sql",
      when: 2_300_000_000_000,
    };
    const secondMigration = {
      content: "CREATE TABLE fitness.legacy_history_second (id integer PRIMARY KEY);",
      file: "0002_legacy_history_second.sql",
      when: 2_300_000_000_001,
    };
    writeTestMigrationFiles(tmpDir, [firstMigration, secondMigration]);

    await client.connect();
    try {
      await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");
      await client.query(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )`);
      await client.query(firstMigration.content);
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ($1, $2)`,
        [firstMigration.file, 9_000_000_000_000],
      );

      const count = await runMigrations(ctx.connectionString, tmpDir);

      expect(count).toBe(1);
      const result = await client.query(
        "SELECT to_regclass('fitness.legacy_history_second') IS NOT NULL AS relation_exists",
      );
      expect(relationExistsRowsSchema.parse(result.rows)).toEqual([{ relation_exists: true }]);
    } finally {
      await client.query(
        `DELETE FROM drizzle.__drizzle_migrations
         WHERE created_at IN ($1, $2, $3)`,
        [firstMigration.when, secondMigration.when, 9_000_000_000_000],
      );
      await client.query("DROP TABLE IF EXISTS fitness.legacy_history_second");
      await client.query("DROP TABLE IF EXISTS fitness.legacy_history_first");
      await client.end();
    }
  });

  it("handles multiple statement breakpoints", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-multi-"));
    writeTestMigration(
      tmpDir,
      "0001_multi.sql",
      [
        "CREATE TABLE IF NOT EXISTS fitness.multi_a (id serial PRIMARY KEY);",
        "--> statement-breakpoint",
        "CREATE TABLE IF NOT EXISTS fitness.multi_b (id serial PRIMARY KEY);",
      ].join("\n"),
    );

    const count = await runMigrations(ctx.connectionString, tmpDir);
    expect(count).toBe(1);

    // Verify both tables were created
    const client = new Client({ connectionString: ctx.connectionString });
    await client.connect();
    const result = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'fitness'
       AND table_name IN ('multi_a', 'multi_b')
       ORDER BY table_name`,
    );
    expect(tableNameRowsSchema.parse(result.rows).length).toBe(2);
    await client.end();
  });

  it("rolls back every statement and the tracking row when a migration file fails", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-atomic-"));
    const migration = {
      content: [
        "CREATE TABLE fitness.atomic_migration_test (id integer PRIMARY KEY);",
        "--> statement-breakpoint",
        "ALTER TABLE fitness.atomic_migration_missing ADD COLUMN value integer;",
      ].join("\n"),
      file: "9998_atomic_failure.sql",
      when: nextMigrationTimestamp++,
    };
    writeTestMigrationFiles(tmpDir, [migration]);

    const expectAtomicFailure = async (): Promise<void> => {
      await expect(runMigrations(ctx.connectionString, tmpDir)).rejects.toThrow(
        "ALTER TABLE fitness.atomic_migration_missing ADD COLUMN value integer",
      );

      const client = new Client({ connectionString: ctx.connectionString });
      await client.connect();
      try {
        const result = await client.query(
          `SELECT
            to_regclass('fitness.atomic_migration_test') IS NOT NULL AS relation_exists,
            EXISTS (
              SELECT 1
              FROM drizzle.__drizzle_migrations
              WHERE created_at = $1
            ) AS migration_record_exists`,
          [migration.when],
        );
        expect(migrationRollbackRowsSchema.parse(result.rows)).toEqual([
          { migration_record_exists: false, relation_exists: false },
        ]);
      } finally {
        await client.end();
      }
    };

    await expectAtomicFailure();
    await expectAtomicFailure();
  });

  it("applies pending billing migration when billing indexes already exist", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-billing-"));
    const billingMigration = readFileSync(
      join(import.meta.dirname, "../../drizzle/0002_add_user_billing.sql"),
      "utf-8",
    );
    writeTestMigration(tmpDir, "0002_add_user_billing.sql", billingMigration);

    const count = await runMigrations(ctx.connectionString, tmpDir);

    expect(count).toBe(1);
  });

  it("drops derived resting heart rate when it exists as a materialized view", async () => {
    const client = new Client({ connectionString: ctx.connectionString });
    await client.connect();
    try {
      await client.query(`
        DO $$
        DECLARE
          relation_kind "char";
        BEGIN
          SELECT pg_class.relkind
            INTO relation_kind
          FROM pg_class
          INNER JOIN pg_namespace
            ON pg_namespace.oid = pg_class.relnamespace
          WHERE pg_namespace.nspname = 'fitness'
            AND pg_class.relname = 'derived_resting_heart_rate';

          IF relation_kind = 'm' THEN
            DROP MATERIALIZED VIEW fitness.derived_resting_heart_rate;
          ELSIF relation_kind = 'v' THEN
            DROP VIEW fitness.derived_resting_heart_rate;
          ELSIF relation_kind IS NOT NULL THEN
            RAISE EXCEPTION 'fitness.derived_resting_heart_rate has unsupported relation kind %', relation_kind;
          END IF;
        END;
        $$;
      `);
      await client.query(
        "CREATE MATERIALIZED VIEW fitness.derived_resting_heart_rate AS SELECT 52::real AS resting_hr",
      );
    } finally {
      await client.end();
    }

    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-derived-rhr-"));
    const migration = readFileSync(
      join(import.meta.dirname, "../../drizzle/0017_drop_derived_resting_heart_rate.sql"),
      "utf-8",
    );
    writeTestMigration(tmpDir, "9999_drop_derived_resting_heart_rate.sql", migration);

    const count = await runMigrations(ctx.connectionString, tmpDir);

    expect(count).toBe(1);
    const verificationClient = new Client({ connectionString: ctx.connectionString });
    await verificationClient.connect();
    try {
      const relationResult = await verificationClient.query(`
        SELECT to_regclass('fitness.derived_resting_heart_rate') IS NOT NULL AS relation_exists
      `);
      expect(relationExistsRowsSchema.parse(relationResult.rows)).toEqual([
        { relation_exists: false },
      ]);
    } finally {
      await verificationClient.end();
    }
  });

  it("drops the retired Postgres metric_stream table", async () => {
    const client = new Client({ connectionString: ctx.connectionString });
    await client.connect();
    try {
      const tableResult = await client.query(`
        SELECT to_regclass('fitness.metric_stream') IS NOT NULL AS relation_exists
      `);
      expect(relationExistsRowsSchema.parse(tableResult.rows)).toEqual([
        { relation_exists: false },
      ]);
    } finally {
      await client.end();
    }
  });

  it("gives oauth_token its schema-declared composite primary key", async () => {
    const client = new Client({ connectionString: ctx.connectionString });
    await client.connect();
    try {
      const nullableResult = await client.query(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'fitness'
          AND table_name = 'oauth_token'
          AND column_name = 'user_id'
      `);
      expect(nullableRowsSchema.parse(nullableResult.rows)).toEqual([{ is_nullable: "NO" }]);

      const primaryKeyResult = await client.query(`
        SELECT string_agg(column_name, ',' ORDER BY ordinal_position) AS columns
        FROM information_schema.key_column_usage
        WHERE table_schema = 'fitness'
          AND table_name = 'oauth_token'
          AND constraint_name = 'oauth_token_pkey'
        GROUP BY constraint_name
      `);
      expect(primaryKeyRowsSchema.parse(primaryKeyResult.rows)).toEqual([
        { columns: "user_id,provider_id" },
      ]);
    } finally {
      await client.end();
    }
  });
});
