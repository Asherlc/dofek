import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
const migrationHashRowsSchema = z.array(z.object({ hash: z.string() }));
const climbingEntryLeadColumnRowsSchema = z.array(
  z.object({
    data_type: z.literal("boolean"),
    is_nullable: z.literal("YES"),
    constraint_definition: z.string(),
  }),
);
const accountErasureTriggerRowsSchema = z.array(
  z.object({
    function_name: z.string(),
    table_name: z.string(),
  }),
);
let nextMigrationTimestamp = 2_000_000_000_000;

function writeTestMigration(migrationsDir: string, file: string, content: string): void {
  writeTestMigrationFiles(migrationsDir, [{ content, file, when: nextMigrationTimestamp++ }]);
}

describe("runMigrations", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestDatabase();
  }, 120_000);

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it("runs migrations successfully and returns count", async () => {
    // Create a fresh database for this test (the test helper already ran migrations,
    // so we test with a temporary migrations directory containing a single migration)
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-"));
    writeTestMigration(
      tmpDir,
      "0001_test.sql",
      "CREATE TABLE IF NOT EXISTS health.migrate_test (id serial PRIMARY KEY, name text);",
    );

    const count = await runMigrations(ctx.connectionString, tmpDir);
    expect(count).toBe(1);

    // Verify the table was created
    const client = new Client({ connectionString: ctx.connectionString });
    await client.connect();
    const result = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'health' AND table_name = 'migrate_test'`,
    );
    expect(tableNameRowsSchema.parse(result.rows).length).toBe(1);
    await client.end();
  });

  it("creates a nullable route-only lead value for climbing entries", async () => {
    const client = new Client({ connectionString: ctx.connectionString });
    await client.connect();
    try {
      const result = await client.query(
        `SELECT
          columns.data_type,
          columns.is_nullable,
          pg_get_constraintdef(constraints.oid) AS constraint_definition
        FROM information_schema.columns AS columns
        JOIN pg_constraint AS constraints
          ON constraints.conname = 'climbing_entry_lead_routes_only'
        WHERE columns.table_schema = 'fitness'
          AND columns.table_name = 'climbing_entry'
          AND columns.column_name = 'lead'`,
      );

      expect(climbingEntryLeadColumnRowsSchema.parse(result.rows)).toEqual([
        {
          data_type: "boolean",
          is_nullable: "YES",
          constraint_definition:
            "CHECK (((lead IS NULL) OR (climb_type = 'route'::fitness.climbing_climb_type)))",
        },
      ]);
    } finally {
      await client.end();
    }
  });

  it("retains canonical breathwork and menstrual records after all migrations", async () => {
    const client = new Client({ connectionString: ctx.connectionString });
    await client.connect();
    const result = await client.query(`
      SELECT
        to_regclass('fitness.breathwork_session') IS NOT NULL AS breathwork_exists,
        to_regclass('fitness.menstrual_period') IS NOT NULL AS menstrual_period_exists
    `);
    expect(result.rows).toEqual([{ breathwork_exists: true, menstrual_period_exists: true }]);
    await client.end();
  });

  it("skips already-applied migrations on second run", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-idempotent-"));
    writeTestMigration(
      tmpDir,
      "0001_test_idempotent.sql",
      "CREATE TABLE IF NOT EXISTS health.migrate_idempotent_test (id serial PRIMARY KEY);",
    );

    const firstCount = await runMigrations(ctx.connectionString, tmpDir);
    expect(firstCount).toBe(1);

    const secondCount = await runMigrations(ctx.connectionString, tmpDir);
    expect(secondCount).toBe(0);
  });

  it("refreshes write fences for future direct and transitive user tables", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-account-erasure-owned-"));
    writeTestMigration(
      tmpDir,
      "0001_future_account_erasure_owned.sql",
      `CREATE TABLE fitness.future_account_erasure_owner (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES fitness.user_profile(id)
      );
      CREATE TABLE fitness.future_account_erasure_child (
        id uuid PRIMARY KEY,
        owner_id uuid NOT NULL REFERENCES fitness.future_account_erasure_owner(id)
      );`,
    );

    await expect(runMigrations(ctx.connectionString, tmpDir)).resolves.toBe(1);

    const client = new Client({ connectionString: ctx.connectionString });
    await client.connect();
    try {
      const triggerRows = await client.query(
        `SELECT
           trigger_function.proname AS function_name,
           relation.relname AS table_name
         FROM pg_trigger AS trigger
         JOIN pg_proc AS trigger_function ON trigger_function.oid = trigger.tgfoid
         JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'fitness'
           AND relation.relname IN (
             'future_account_erasure_owner',
             'future_account_erasure_child'
           )
           AND NOT trigger.tgisinternal
         ORDER BY relation.relname`,
      );
      expect(accountErasureTriggerRowsSchema.parse(triggerRows.rows)).toEqual([
        {
          function_name: "reject_transitive_account_erasure_write",
          table_name: "future_account_erasure_child",
        },
        {
          function_name: "reject_account_erasure_write",
          table_name: "future_account_erasure_owner",
        },
      ]);
    } finally {
      await client.end();
    }
  });

  it("fails migration startup for a future table without an ownership or shared policy", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-account-erasure-unclassified-"));
    writeTestMigration(
      tmpDir,
      "0001_future_account_erasure_unclassified.sql",
      `CREATE TABLE fitness.future_account_erasure_unclassified (
        id uuid PRIMARY KEY,
        label text NOT NULL
      );`,
    );

    await expect(runMigrations(ctx.connectionString, tmpDir)).rejects.toThrow(
      "fitness.future_account_erasure_unclassified has no ownership or shared-system policy",
    );
  });

  it("rejects a modified applied Drizzle migration before applying pending work", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-modified-history-"));
    const appliedMigration = {
      content: "CREATE TABLE health.integrity_applied (id integer PRIMARY KEY);",
      file: "0001_integrity_applied.sql",
      when: nextMigrationTimestamp++,
    };
    writeTestMigrationFiles(tmpDir, [appliedMigration]);
    await runMigrations(ctx.connectionString, tmpDir);

    const pendingMigration = {
      content: "CREATE TABLE health.integrity_pending (id integer PRIMARY KEY);",
      file: "0002_integrity_pending.sql",
      when: nextMigrationTimestamp++,
    };
    writeTestMigrationFiles(tmpDir, [
      { ...appliedMigration, content: `${appliedMigration.content}\n-- modified` },
      pendingMigration,
    ]);

    await expect(runMigrations(ctx.connectionString, tmpDir)).rejects.toThrow(
      "0001_integrity_applied.sql has changed",
    );

    const client = new Client({ connectionString: ctx.connectionString });
    await client.connect();
    try {
      const result = await client.query(
        "SELECT to_regclass('health.integrity_pending') IS NOT NULL AS relation_exists",
      );
      expect(relationExistsRowsSchema.parse(result.rows)).toEqual([{ relation_exists: false }]);
    } finally {
      await client.end();
    }
  });

  it("rejects a missing applied Drizzle journal entry before applying pending work", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-missing-history-"));
    const appliedMigration = {
      content: "CREATE TABLE health.missing_history_applied (id integer PRIMARY KEY);",
      file: "0001_missing_history_applied.sql",
      when: nextMigrationTimestamp++,
    };
    writeTestMigrationFiles(tmpDir, [appliedMigration]);
    await runMigrations(ctx.connectionString, tmpDir);

    const pendingMigration = {
      content: "CREATE TABLE health.missing_history_pending (id integer PRIMARY KEY);",
      file: "0002_missing_history_pending.sql",
      when: nextMigrationTimestamp++,
    };
    writeTestMigrationFiles(tmpDir, [pendingMigration]);

    await expect(runMigrations(ctx.connectionString, tmpDir)).rejects.toThrow(
      `migration tracked at ${appliedMigration.when} is recorded as applied but is missing`,
    );

    const client = new Client({ connectionString: ctx.connectionString });
    await client.connect();
    try {
      const result = await client.query(
        "SELECT to_regclass('health.missing_history_pending') IS NOT NULL AS relation_exists",
      );
      expect(relationExistsRowsSchema.parse(result.rows)).toEqual([{ relation_exists: false }]);
    } finally {
      await client.end();
    }
  });

  it("continues after migrations recorded by the legacy filename tracker", async () => {
    const client = new Client({ connectionString: ctx.connectionString });
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-legacy-history-"));
    const firstMigration = {
      content: "CREATE TABLE health.legacy_history_first (id integer PRIMARY KEY);",
      file: "0001_legacy_history_first.sql",
      when: 2_300_000_000_000,
    };
    const secondMigration = {
      content: "CREATE TABLE health.legacy_history_second (id integer PRIMARY KEY);",
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
        "SELECT to_regclass('health.legacy_history_second') IS NOT NULL AS relation_exists",
      );
      expect(relationExistsRowsSchema.parse(result.rows)).toEqual([{ relation_exists: true }]);
    } finally {
      await client.query(
        `DELETE FROM drizzle.__drizzle_migrations
         WHERE created_at IN ($1, $2, $3)`,
        [firstMigration.when, secondMigration.when, 9_000_000_000_000],
      );
      await client.query("DROP TABLE IF EXISTS health.legacy_history_second");
      await client.query("DROP TABLE IF EXISTS health.legacy_history_first");
      await client.end();
    }
  });

  it("reconciles archived migration history without executing it", async () => {
    const client = new Client({ connectionString: ctx.connectionString });
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-archived-history-"));
    const archivedMigration = {
      content: "CREATE TABLE health.archived_history_must_not_run (id integer PRIMARY KEY);",
      file: "0003_archived_history.sql",
    };
    const pendingMigration = {
      content: "CREATE TABLE health.archived_history_pending (id integer PRIMARY KEY);",
      file: "0004_archived_history_pending.sql",
      when: 2_300_000_000_004,
    };
    writeTestMigrationFiles(tmpDir, [pendingMigration]);
    mkdirSync(join(tmpDir, "_history"));
    writeFileSync(join(tmpDir, "_history", archivedMigration.file), archivedMigration.content);

    await client.connect();
    try {
      await client.query("CREATE SCHEMA drizzle");
      await client.query(`CREATE TABLE drizzle.__drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint,
        content_hash text
      )`);
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ($1, $2)`,
        [archivedMigration.file, 1],
      );

      await expect(runMigrations(ctx.connectionString, tmpDir)).resolves.toBe(1);

      const expectedHash = createHash("sha256").update(archivedMigration.content).digest("hex");
      const migrationRows = await client.query(
        `SELECT hash, content_hash
         FROM drizzle.__drizzle_migrations
         WHERE created_at = 1`,
      );
      expect(migrationRows.rows).toEqual([{ content_hash: expectedHash, hash: expectedHash }]);

      const relationRows = await client.query(`SELECT
        to_regclass('health.archived_history_must_not_run') IS NOT NULL AS archived_ran,
        to_regclass('health.archived_history_pending') IS NOT NULL AS pending_ran`);
      expect(relationRows.rows).toEqual([{ archived_ran: false, pending_ran: true }]);
    } finally {
      await client.query(
        `DELETE FROM drizzle.__drizzle_migrations
         WHERE created_at IN ($1, $2)`,
        [1, pendingMigration.when],
      );
      await client.query("DROP TABLE IF EXISTS health.archived_history_pending");
      await client.end();
    }
  });

  it("rejects modified archived migration history", async () => {
    const client = new Client({ connectionString: ctx.connectionString });
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-modified-archive-"));
    const archivedFile = "0003_modified_archive.sql";
    const originalContent = "SELECT 1;";
    const modifiedContent = "SELECT 2;";
    writeTestMigrationFiles(tmpDir, [
      {
        content: "SELECT 1;",
        file: "0004_pending.sql",
        when: 2_300_000_000_005,
      },
    ]);
    mkdirSync(join(tmpDir, "_history"));
    writeFileSync(join(tmpDir, "_history", archivedFile), modifiedContent);

    await client.connect();
    try {
      await client.query("CREATE SCHEMA drizzle");
      await client.query(`CREATE TABLE drizzle.__drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint,
        content_hash text
      )`);
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at, content_hash)
         VALUES ($1, $2, $3)`,
        [archivedFile, 2, createHash("sha256").update(originalContent).digest("hex")],
      );

      await expect(runMigrations(ctx.connectionString, tmpDir)).rejects.toThrow(
        `${archivedFile} has changed`,
      );
    } finally {
      await client.query("DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 2");
      await client.end();
    }
  });

  it("reconciles the approved transaction-compatibility hash for a legacy migration", async () => {
    const client = new Client({ connectionString: ctx.connectionString });
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-legacy-content-hash-"));
    const migrationFile = "0048_mcp_oauth.sql";
    const migrationContent = readFileSync(
      join(import.meta.dirname, `../../drizzle/${migrationFile}`),
      "utf8",
    );
    const migration = {
      content: migrationContent,
      file: migrationFile,
      when: nextMigrationTimestamp++,
    };
    writeTestMigrationFiles(tmpDir, [migration]);

    await client.connect();
    try {
      await client.query("CREATE SCHEMA drizzle");
      await client.query(`CREATE TABLE drizzle.__drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )`);
      await client.query(`ALTER TABLE drizzle.__drizzle_migrations
        ADD COLUMN IF NOT EXISTS content_hash text`);
      await client.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at, content_hash)
         VALUES ($1, $2, $3)`,
        [
          migration.file,
          9_000_000_000_001,
          "40680a71ef18d7f5463b87ce5c89ccfe28f080a3501c0ebe5f192ff84996c1da",
        ],
      );

      expect(await runMigrations(ctx.connectionString, tmpDir)).toBe(0);
      const result = await client.query(
        "SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = $1",
        [migration.when],
      );
      const expectedHash = createHash("sha256").update(migrationContent).digest("hex");
      expect(migrationHashRowsSchema.parse(result.rows)).toEqual([{ hash: expectedHash }]);
    } finally {
      await client.end();
    }
  });

  it("handles multiple statement breakpoints", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-multi-"));
    writeTestMigration(
      tmpDir,
      "0001_multi.sql",
      [
        "CREATE TABLE IF NOT EXISTS health.multi_a (id serial PRIMARY KEY);",
        "--> statement-breakpoint",
        "CREATE TABLE IF NOT EXISTS health.multi_b (id serial PRIMARY KEY);",
      ].join("\n"),
    );

    const count = await runMigrations(ctx.connectionString, tmpDir);
    expect(count).toBe(1);

    // Verify both tables were created
    const client = new Client({ connectionString: ctx.connectionString });
    await client.connect();
    const result = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'health'
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

  it("separates the global provider catalog from user connections", async () => {
    const client = new Client({ connectionString: ctx.connectionString });
    await client.connect();
    try {
      const nullableResult = await client.query(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'fitness'
          AND table_name = 'provider'
          AND column_name = 'user_id'
      `);
      expect(nullableRowsSchema.parse(nullableResult.rows)).toEqual([{ is_nullable: "YES" }]);

      const primaryKeyResult = await client.query(`
        SELECT string_agg(column_name, ',' ORDER BY ordinal_position) AS columns
        FROM information_schema.key_column_usage
        WHERE table_schema = 'fitness'
          AND table_name = 'provider_connection'
          AND constraint_name = 'provider_connection_pkey'
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
