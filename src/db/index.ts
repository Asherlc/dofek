import type { SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;
type QueryRow = Record<string, unknown>;

export type Database = Omit<DrizzleDatabase, "execute"> & {
  execute: <TRow extends QueryRow = QueryRow>(query: SQLWrapper | string) => Promise<TRow[]>;
};

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

function extractRows<TRow extends QueryRow>(result: unknown): TRow[] {
  if (isRowArray<TRow>(result)) {
    return result;
  }
  if (hasRowsArray<TRow>(result)) {
    return result.rows;
  }
  throw new Error("Unexpected database execute result shape");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isRowArray<TRow extends QueryRow>(value: unknown): value is TRow[] {
  return Array.isArray(value);
}

function hasRowsArray<TRow extends QueryRow>(value: unknown): value is { rows: TRow[] } {
  return isRecord(value) && "rows" in value && Array.isArray(value.rows);
}

export function createDatabase(connectionString: string): Database {
  const client = new Pool({
    connectionString,
    max: 5, // conservative for small server
    idleTimeoutMillis: 300_000, // 5 min — long-running export jobs need connections to survive between queries
    connectionTimeoutMillis: 10_000,
    maxLifetimeSeconds: 600, // 10 min — recycle connections to avoid stale server-side state
    keepAlive: true, // TCP keep-alive detects dead connections from network/server drops
    keepAliveInitialDelayMillis: 60_000,
  });
  const db = drizzle(client, { schema });
  const rawExecute = db.execute.bind(db);
  return Object.assign(db, {
    async execute<TRow extends QueryRow = QueryRow>(query: SQLWrapper | string): Promise<TRow[]> {
      return extractRows<TRow>(await rawExecute(query));
    },
  });
}

export function createDatabaseFromEnv() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  return createDatabase(url);
}
