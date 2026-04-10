import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type Database = ReturnType<typeof createDatabase>;

/**
 * Minimal database interface that providers and DB helpers need.
 * The full Drizzle `Database` type structurally satisfies this,
 * and test mocks can implement it directly without type assertions.
 *
 * This follows the Interface Segregation Principle — production code
 * declares only the DB operations it actually uses, making it testable
 * with lightweight mocks.
 */
export interface SyncDatabase {
  select: Database["select"];
  insert: Database["insert"];
  delete: Database["delete"];
  execute: Database["execute"];
}

export function createDatabase(connectionString: string) {
  const client = postgres(connectionString, {
    max: 5, // conservative for small server
    idle_timeout: 300, // 5 min — long-running export jobs need connections to survive between queries
    connect_timeout: 10,
    max_lifetime: 600, // 10 min — recycle connections to avoid stale server-side state
    keep_alive: 60, // TCP keep-alive every 60s — detects dead connections from network/server drops
  });
  return drizzle(client, { schema });
}

export function createDatabaseFromEnv() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  return createDatabase(url);
}
