import type { SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import { drizzleSchema as schema } from "./drizzle-schema.ts";
import { registerPostgresPoolMetrics } from "./pool-metrics.ts";

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;
type RawTransactionDatabase = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];
type QueryRow = Record<string, unknown>;
type Execute = <TRow extends QueryRow = QueryRow>(query: SQLWrapper | string) => Promise<TRow[]>;
type TransactionConfig = Parameters<DrizzleDatabase["transaction"]>[1];

export type Database = Omit<DrizzleDatabase, "execute" | "transaction"> & {
  execute: Execute;
  transaction<T>(
    operation: (transaction: TransactionDatabase) => Promise<T>,
    config?: TransactionConfig,
  ): Promise<T>;
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

/**
 * A Drizzle transaction whose raw execute result is normalized to the same
 * row-array contract as Database.execute.
 */
export interface TransactionDatabase {
  delete: DrizzleDatabase["delete"];
  execute: Execute;
  insert: DrizzleDatabase["insert"];
  query: DrizzleDatabase["query"];
  select: DrizzleDatabase["select"];
  transaction<T>(operation: (transaction: TransactionDatabase) => Promise<T>): Promise<T>;
  update: DrizzleDatabase["update"];
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

function normalizeTransaction(transaction: RawTransactionDatabase): TransactionDatabase {
  const rawExecute = transaction.execute.bind(transaction);
  const rawTransaction = transaction.transaction.bind(transaction);
  return {
    delete: transaction.delete.bind(transaction),
    async execute<TRow extends QueryRow = QueryRow>(query: SQLWrapper | string): Promise<TRow[]> {
      return extractRows<TRow>(await rawExecute(query));
    },
    insert: transaction.insert.bind(transaction),
    query: transaction.query,
    select: transaction.select.bind(transaction),
    transaction<T>(operation: (nested: TransactionDatabase) => Promise<T>): Promise<T> {
      return rawTransaction((nested) => operation(normalizeTransaction(nested)));
    },
    update: transaction.update.bind(transaction),
  };
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
  registerPostgresPoolMetrics(client);
  client.on("error", (error) => {
    logger.error(`[db] PostgreSQL pool idle client error: ${error.message}`);
    captureException(error, { tags: { source: "postgres-pool" } });
  });
  const db = drizzle(client, { schema });
  const rawExecute = db.execute.bind(db);
  const rawTransaction = db.transaction.bind(db);
  return Object.assign(db, {
    async execute<TRow extends QueryRow = QueryRow>(query: SQLWrapper | string): Promise<TRow[]> {
      return extractRows<TRow>(await rawExecute(query));
    },
    transaction<T>(
      operation: (transaction: TransactionDatabase) => Promise<T>,
      config?: TransactionConfig,
    ): Promise<T> {
      return rawTransaction((transaction) => operation(normalizeTransaction(transaction)), config);
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
