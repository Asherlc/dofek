import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, escapeIdentifier } from "pg";
import { createDatabase } from "./index.ts";
import { runMigrations } from "./migrate.ts";
import { withMigrationPrefix } from "./migration-prefix.ts";

export async function setupClimbingConversionDatabase() {
  const adminUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!adminUrl) throw new Error("TEST_DATABASE_URL is required for conversion tests.");
  const databaseName = `dofek_conversion_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  const db = createDatabase(url.toString());
  const directory = resolve(import.meta.dirname, "../../drizzle");
  async function cleanup() {
    await db.$client.end();
    const client = new Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(`DROP DATABASE ${escapeIdentifier(databaseName)}`);
    } finally {
      await client.end();
    }
  }
  let ready = false;
  try {
    await withMigrationPrefix(directory, 145, (prefix) => runMigrations(url.toString(), prefix));
    ready = true;
  } finally {
    if (!ready) await cleanup();
  }
  return {
    db,
    connectionString: url.toString(),
    cleanup,
    prepare: () =>
      withMigrationPrefix(directory, 146, (prefix) => runMigrations(url.toString(), prefix)),
    finalize: () => runMigrations(url.toString(), directory),
    finalSql: () =>
      readFileSync(resolve(directory, "0147_climbing_log_model_finalize.sql"), "utf8"),
  };
}
