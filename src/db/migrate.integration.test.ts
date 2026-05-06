import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, escapeIdentifier } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

// cspell:ignore pkey relname relnamespace relreplident nspname

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

  it("recreates v_daily_metrics when the existing view has the old column order", async () => {
    const adminConnectionString = process.env.TEST_DATABASE_URL ?? ctx.connectionString;
    const databaseName = `migration_view_${randomBytes(6).toString("hex")}`;
    const adminClient = new Client({ connectionString: adminConnectionString });
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`);
    await adminClient.end();

    const databaseUrl = new URL(adminConnectionString);
    databaseUrl.pathname = `/${databaseName}`;
    const connectionString = databaseUrl.toString();
    const tmpDir = mkdtempSync(join(tmpdir(), "migrate-test-daily-metrics-view-"));

    try {
      writeFileSync(
        join(tmpDir, "0001_setup_old_daily_metrics_view.sql"),
        `
        CREATE SCHEMA fitness;
        CREATE TABLE fitness.user_profile (
          id uuid PRIMARY KEY,
          name text,
          max_hr integer,
          resting_hr integer,
          ftp integer,
          birth_date date
        );
        CREATE TABLE fitness.metric_stream (
          user_id uuid,
          provider_id text,
          channel text,
          recorded_at timestamptz,
          scalar numeric
        );
        CREATE VIEW fitness.v_sleep AS
        SELECT
          NULL::uuid AS id,
          NULL::uuid AS user_id,
          NULL::timestamptz AS started_at,
          NULL::timestamptz AS ended_at,
          NULL::numeric AS duration_minutes,
          NULL::numeric AS deep_minutes,
          NULL::numeric AS rem_minutes,
          NULL::numeric AS light_minutes,
          NULL::numeric AS awake_minutes,
          NULL::numeric AS efficiency_pct,
          false AS is_nap,
          NULL::text AS sleep_type
        WHERE false;
        CREATE TABLE fitness.provider_priority (
          provider_id text PRIMARY KEY,
          recovery_priority integer,
          daily_activity_priority integer,
          body_priority integer,
          priority integer
        );
        CREATE TABLE fitness.device_priority (
          provider_id text,
          source_name_pattern text,
          recovery_priority integer,
          daily_activity_priority integer,
          body_priority integer,
          priority integer
        );
        CREATE TABLE fitness.body_measurement (
          id uuid PRIMARY KEY,
          provider_id text,
          user_id uuid,
          recorded_at timestamptz,
          source_name text,
          weight_kg numeric,
          body_fat_pct numeric,
          muscle_mass_kg numeric,
          bmi numeric,
          systolic_bp numeric,
          diastolic_bp numeric,
          temperature_c numeric,
          height_cm numeric
        );
        CREATE TABLE fitness.daily_metrics (
          id uuid PRIMARY KEY,
          provider_id text,
          user_id uuid,
          date date,
          source_name text,
          hrv numeric,
          spo2_avg numeric,
          respiratory_rate_avg numeric,
          skin_temp_c numeric,
          steps integer,
          active_energy_kcal numeric,
          basal_energy_kcal numeric,
          distance_km numeric,
          flights_climbed integer,
          exercise_minutes integer,
          stand_hours integer,
          walking_speed numeric,
          walking_step_length numeric,
          walking_double_support_pct numeric,
          walking_asymmetry_pct numeric,
          walking_steadiness numeric
        );
        CREATE TABLE fitness.activity (
          id uuid PRIMARY KEY,
          user_id uuid,
          provider_id text,
          activity_type text,
          name text,
          started_at timestamptz,
          ended_at timestamptz,
          source_name text
        );
        CREATE VIEW fitness.v_daily_metrics AS
        SELECT
          NULL::date AS date,
          NULL::uuid AS user_id,
          NULL::numeric AS hrv,
          NULL::numeric AS spo2_avg,
          NULL::numeric AS respiratory_rate_avg,
          NULL::numeric AS skin_temp_c,
          NULL::integer AS steps,
          NULL::numeric AS active_energy_kcal,
          NULL::numeric AS basal_energy_kcal,
          NULL::numeric AS distance_km,
          NULL::integer AS flights_climbed,
          NULL::integer AS exercise_minutes,
          NULL::integer AS stand_hours,
          NULL::numeric AS walking_speed,
          ARRAY[]::text[] AS source_providers
        WHERE false;
      `,
      );
      writeFileSync(
        join(tmpDir, "0015_clickhouse_proxy_views.sql"),
        readFileSync(join(import.meta.dirname, "../../drizzle/0015_clickhouse_proxy_views.sql")),
      );

      const count = await runMigrations(connectionString, tmpDir);
      expect(count).toBe(2);

      const client = new Client({ connectionString });
      await client.connect();
      try {
        const columns = await client.query<{ column_name: string }>(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'fitness'
            AND table_name = 'v_daily_metrics'
          ORDER BY ordinal_position
        `);
        expect(columns.rows.map((row) => row.column_name).slice(-5)).toEqual([
          "walking_step_length",
          "walking_double_support_pct",
          "walking_asymmetry_pct",
          "walking_steadiness",
          "source_providers",
        ]);
      } finally {
        await client.end();
      }
    } finally {
      const cleanupClient = new Client({ connectionString: adminConnectionString });
      await cleanupClient.connect();
      await cleanupClient.query(`DROP DATABASE ${escapeIdentifier(databaseName)} WITH (FORCE)`);
      await cleanupClient.end();
    }
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

  it("gives oauth_token its schema-declared composite primary key", async () => {
    const client = new Client({ connectionString: ctx.connectionString });
    await client.connect();
    try {
      const nullableResult = await client.query<{ is_nullable: "YES" | "NO" }>(`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'fitness'
          AND table_name = 'oauth_token'
          AND column_name = 'user_id'
      `);
      expect(nullableResult.rows).toEqual([{ is_nullable: "NO" }]);

      const primaryKeyResult = await client.query<{ columns: string }>(`
        SELECT string_agg(column_name, ',' ORDER BY ordinal_position) AS columns
        FROM information_schema.key_column_usage
        WHERE table_schema = 'fitness'
          AND table_name = 'oauth_token'
          AND constraint_name = 'oauth_token_pkey'
        GROUP BY constraint_name
      `);
      expect(primaryKeyResult.rows).toEqual([{ columns: "user_id,provider_id" }]);
    } finally {
      await client.end();
    }
  });
});
