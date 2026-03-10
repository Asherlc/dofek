import { GenericContainer } from "testcontainers";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema.js";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface TestContext {
  db: TestDatabase;
  connectionString: string;
  cleanup: () => Promise<void>;
}

/**
 * Spin up a TimescaleDB container, create schema, run migrations.
 * Call cleanup() in afterAll to tear down.
 */
export async function setupTestDatabase(): Promise<TestContext> {
  const container = await new GenericContainer("timescale/timescaledb:latest-pg16")
    .withEnvironment({
      POSTGRES_DB: "test",
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
    })
    .withExposedPorts(5432)
    .start();

  const connectionString = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/test`;

  // Run all migrations in order
  const migrationClient = postgres(connectionString, { max: 1 });
  const drizzleDir = resolve(import.meta.dirname, "../../../drizzle");
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
      await container.stop();
    },
  };
}
