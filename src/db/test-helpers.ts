import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { GenericContainer } from "testcontainers";
import * as schema from "./schema.ts";

export type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface TestContext {
  db: TestDatabase;
  connectionString: string;
  cleanup: () => Promise<void>;
}

/**
 * Spin up a TimescaleDB container (or use TEST_DATABASE_URL), create schema, run migrations.
 * When TEST_DATABASE_URL is set, creates an isolated database per test file to avoid
 * concurrent migration collisions. Call cleanup() in afterAll to tear down.
 */
export async function setupTestDatabase(): Promise<TestContext> {
  let connectionString: string;
  let container: Awaited<ReturnType<GenericContainer["start"]>> | null = null;
  let adminUrl: string | null = null;
  let dbName: string | null = null;

  if (process.env.TEST_DATABASE_URL) {
    // CI: create an isolated database per test file on the shared Postgres instance
    adminUrl = process.env.TEST_DATABASE_URL;
    dbName = `test_${randomBytes(6).toString("hex")}`;
    const admin = postgres(adminUrl, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.end();

    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    connectionString = url.toString();
  } else {
    // Local: spin up a testcontainer
    container = await new GenericContainer("timescale/timescaledb:latest-pg16")
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
      const probe = postgres(connectionString, { max: 1 });
      await probe`SELECT 1`;
      await probe.end();
      break;
    } catch {
      if (attempt === 29) throw new Error("Database did not become ready in time");
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Run all migrations in order
  const migrationClient = postgres(connectionString, { max: 1 });
  const drizzleDir = resolve(import.meta.dirname, "../../drizzle");
  const migrationFiles = readdirSync(drizzleDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(resolve(drizzleDir, file), "utf-8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await migrationClient.unsafe(statement);
    }
  }
  await migrationClient.end();

  const client = postgres(connectionString);
  const db = drizzle(client, { schema });

  return {
    db,
    connectionString,
    cleanup: async () => {
      await client.end();
      if (container) {
        await container.stop();
      } else if (adminUrl && dbName) {
        const admin = postgres(adminUrl, { max: 1 });
        await admin.unsafe(`DROP DATABASE ${dbName} WITH (FORCE)`);
        await admin.end();
      }
    },
  };
}
