import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

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
    writeFileSync(
      join(tmpDir, "0001_test.sql"),
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
    expect(result.rows.length).toBe(1);
    await client.end();
  });

  it("skips already-applied migrations on second run", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-idempotent-"));
    writeFileSync(
      join(tmpDir, "0001_test_idempotent.sql"),
      "CREATE TABLE IF NOT EXISTS fitness.migrate_idempotent_test (id serial PRIMARY KEY);",
    );

    const firstCount = await runMigrations(ctx.connectionString, tmpDir);
    expect(firstCount).toBe(1);

    const secondCount = await runMigrations(ctx.connectionString, tmpDir);
    expect(secondCount).toBe(0);
  });

  it("handles multiple statement breakpoints", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-multi-"));
    writeFileSync(
      join(tmpDir, "0001_multi.sql"),
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
    expect(result.rows.length).toBe(2);
    await client.end();
  });

  it("applies pending billing migration when billing indexes already exist", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-billing-"));
    const billingMigration = readFileSync(
      join(import.meta.dirname, "../../drizzle/0002_add_user_billing.sql"),
      "utf-8",
    );
    writeFileSync(join(tmpDir, "0002_add_user_billing.sql"), billingMigration);

    const count = await runMigrations(ctx.connectionString, tmpDir);

    expect(count).toBe(1);
  });

  it("gives metric_stream full replica identity and a Timescale-compatible primary key", async () => {
    const client = new Client({ connectionString: ctx.connectionString });
    await client.connect();
    try {
      const replicaIdentityResult = await client.query<{
        replica_identity: string;
      }>(
        `SELECT class.relreplident AS replica_identity
         FROM pg_class class
         JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
         WHERE namespace.nspname = 'fitness'
           AND class.relname = 'metric_stream'`,
      );
      expect(replicaIdentityResult.rows).toEqual([{ replica_identity: "f" }]);

      const nullableResult = await client.query<{ is_nullable: "YES" | "NO" }>(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'fitness'
          AND table_name = 'metric_stream'
          AND column_name = 'id'
      `);
      expect(nullableResult.rows).toEqual([{ is_nullable: "NO" }]);

      const primaryKeyResult = await client.query<{ columns: string }>(`
        SELECT string_agg(column_name, ',' ORDER BY ordinal_position) AS columns
        FROM information_schema.key_column_usage
        WHERE table_schema = 'fitness'
          AND table_name = 'metric_stream'
          AND constraint_name = 'metric_stream_pkey'
        GROUP BY constraint_name
      `);
      expect(primaryKeyResult.rows).toEqual([{ columns: "id,recorded_at" }]);
    } finally {
      await client.end();
    }
  });
});
