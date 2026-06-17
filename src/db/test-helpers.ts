import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client, escapeIdentifier } from "pg";
import { GenericContainer } from "testcontainers";
import { createDatabase } from "./index.ts";
import * as schema from "./schema.ts";

export type TestDatabase = ReturnType<typeof createDatabase>;

export interface TestContext {
  db: TestDatabase;
  connectionString: string;
  addCleanup: (cleanup: () => Promise<void>) => void;
  cleanup: () => Promise<void>;
}

interface SetupTestDatabaseOptions {
  createRetiredMetricStreamFixture?: boolean;
}

const isRunnableMigrationStatement = (statement: string): boolean =>
  statement.length > 0 && !statement.includes("CREATE OR REPLACE VIEW clickhouse.v_sleep AS");

async function createRetiredMetricStreamFixtureTable(client: Client): Promise<void> {
  await client.query("CREATE EXTENSION IF NOT EXISTS postgis");

  await client.query(`
    CREATE TABLE IF NOT EXISTS fitness.metric_stream (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      recorded_at timestamptz NOT NULL,
      user_id uuid NOT NULL REFERENCES fitness.user_profile(id),
      provider_id text NOT NULL REFERENCES fitness.provider(id),
      external_id text,
      device_id text,
      source_type text NOT NULL,
      channel text NOT NULL,
      activity_id uuid REFERENCES fitness.activity(id) ON DELETE CASCADE,
      scalar real,
      vector real[],
      point public.geometry(Point, 4326),
      metadata jsonb,
      PRIMARY KEY (id, recorded_at)
    )
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS metric_stream_provider_external_channel_time_idx
      ON fitness.metric_stream (user_id, provider_id, external_id, channel, recorded_at)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS metric_stream_user_channel_time_idx
      ON fitness.metric_stream (user_id, channel, recorded_at)
  `);
}

/**
 * Spin up a TimescaleDB container (or use TEST_DATABASE_URL), create schema, run migrations.
 * When TEST_DATABASE_URL is set, creates an isolated database per test file to avoid
 * concurrent migration collisions. Call cleanup() in afterAll to tear down.
 */
export async function setupTestDatabase(
  options: SetupTestDatabaseOptions = {},
): Promise<TestContext> {
  let connectionString: string;
  let container: Awaited<ReturnType<GenericContainer["start"]>> | null = null;
  let adminUrl: string | null = null;
  let dbName: string | null = null;
  const cleanupTasks: Array<() => Promise<void>> = [];

  if (process.env.TEST_DATABASE_URL) {
    // CI: create an isolated database per test file on the shared Postgres instance
    adminUrl = process.env.TEST_DATABASE_URL;
    dbName = `test_${randomBytes(6).toString("hex")}`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${escapeIdentifier(dbName)}`);
    await admin.end();

    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    connectionString = url.toString();
  } else {
    // Local: spin up a testcontainer
    container = await new GenericContainer(
      "mirror.gcr.io/timescale/timescaledb-ha:pg18.3-ts2.26.4-all",
    )
      .withEnvironment({
        POSTGRES_DB: "test",
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .start();

    connectionString = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/test`;
  }

  // Wait for PostgreSQL to be ready
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const probe = new Client({ connectionString });
      await probe.connect();
      await probe.query("SELECT 1");
      await probe.end();
      break;
    } catch {
      if (attempt === 29) throw new Error("Database did not become ready in time");
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Run all migrations in order, then recreate canonical views
  const migrationClient = new Client({ connectionString });
  await migrationClient.connect();
  const drizzleDir = resolve(import.meta.dirname, "../../drizzle");
  const migrationFiles = readdirSync(drizzleDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const content = readFileSync(resolve(drizzleDir, file), "utf-8");
    const statements = content
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(isRunnableMigrationStatement);

    for (const statement of statements) {
      await migrationClient.query(statement);
    }
  }

  // Recreate canonical fitness views from their checked-in definitions.
  const viewsDir = join(drizzleDir, "_views");
  if (existsSync(viewsDir)) {
    const viewFiles = readdirSync(viewsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    // Parse view files upfront so we know which views to drop.
    // Only files containing CREATE MATERIALIZED VIEW are matviews; CREATE OR
    // REPLACE VIEW files are plain views (handled differently below).
    const parsedViews = viewFiles.map((file) => {
      const content = readFileSync(join(viewsDir, file), "utf-8");
      const match = content.match(
        /CREATE\s+MATERIALIZED\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?fitness\.(\w+)/i,
      );
      return { content, viewName: match?.[1] };
    });

    // Drop managed matviews in reverse order (dependents first). CASCADE is
    // used so dependencies are removed before canonical definitions are
    // recreated below.
    for (const { viewName } of [...parsedViews].reverse()) {
      if (!viewName) continue;
      await migrationClient.query(
        `DROP MATERIALIZED VIEW IF EXISTS ${escapeIdentifier("fitness")}.${escapeIdentifier(viewName)} CASCADE`,
      );
    }

    // Recreate in filename order so base views exist before dependents.
    for (const { content } of parsedViews) {
      const statements = content
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const statement of statements) {
        await migrationClient.query(statement);
      }
    }
  }

  for (const file of [
    "0008_clickhouse_activity_views.sql",
    "0017_drop_derived_resting_heart_rate.sql",
    "0019_clickhouse_proxy_views_after_body_measurement_migration.sql",
    "0025_drop_v_sleep.sql",
  ]) {
    const content = readFileSync(resolve(drizzleDir, file), "utf-8");
    const statements = content
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(isRunnableMigrationStatement);

    for (const statement of statements) {
      await migrationClient.query(statement);
    }
  }

  // Seed the canonical integration-test user.
  // Many integration tests use TEST_USER_ID fixtures and expect this row to exist.
  await migrationClient.query(
    `INSERT INTO fitness.user_profile (id, name)
     VALUES ($1, 'Test User')
     ON CONFLICT (id) DO NOTHING`,
    [schema.TEST_USER_ID],
  );

  // Seed billing record with existing_account grant so tests get full access.
  await migrationClient.query(
    `INSERT INTO fitness.user_billing (user_id, paid_grant_reason)
     VALUES ($1, 'existing_account')
     ON CONFLICT (user_id) DO NOTHING`,
    [schema.TEST_USER_ID],
  );

  if (options.createRetiredMetricStreamFixture) {
    await createRetiredMetricStreamFixtureTable(migrationClient);
  }

  await migrationClient.end();

  const db = createDatabase(connectionString);

  return {
    db,
    connectionString,
    addCleanup: (cleanup) => {
      cleanupTasks.push(cleanup);
    },
    cleanup: async () => {
      for (const cleanupTask of [...cleanupTasks].reverse()) {
        await cleanupTask();
      }
      await db.$client.end();
      if (container) {
        await container.stop();
      } else if (adminUrl && dbName) {
        const admin = new Client({ connectionString: adminUrl });
        await admin.connect();
        await admin.query(`DROP DATABASE ${escapeIdentifier(dbName)} WITH (FORCE)`);
        await admin.end();
      }
    },
  };
}
