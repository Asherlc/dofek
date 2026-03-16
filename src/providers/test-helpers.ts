/**
 * Shared test helpers for provider unit tests.
 *
 * Provides a `createMockDatabase()` factory that returns a properly typed
 * `SyncDatabase` mock — eliminating the need for type suppression
 * comments throughout provider test files.
 */
import { vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";

/**
 * Options for configuring the mock database behavior.
 */
export interface MockDatabaseOptions {
  /** Rows returned by `select().from().where().limit()` (default: []) */
  tokensResult?: Record<string, unknown>[];
  /** Number of upsert calls to allow before throwing `insertError` */
  insertErrorAfterCalls?: number;
  /** Error to throw from `onConflictDoUpdate` after `insertErrorAfterCalls` calls */
  insertError?: Error;
  /** Rows returned by `execute()` (default: []) */
  executeResult?: unknown[];
}

/**
 * Mock implementations exposed for test assertions.
 * Access these to verify what the provider called on the database.
 */
export interface MockDatabaseSpies {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  onConflictDoNothing: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  deleteFn: ReturnType<typeof vi.fn>;
  deleteWhere: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

export interface MockDatabaseResult {
  db: SyncDatabase;
  spies: MockDatabaseSpies;
}

/**
 * Create a mock database that satisfies the `SyncDatabase` interface.
 *
 * Returns both the typed `db` (ready to pass to `provider.sync()`) and
 * a `spies` object for test assertions.
 *
 * Usage:
 * ```ts
 * const { db, spies } = createMockDatabase({ tokensResult: [tokenRow] });
 * const result = await provider.sync(db, since);
 * expect(spies.insert).toHaveBeenCalled();
 * ```
 */
export function createMockDatabase(options: MockDatabaseOptions = {}): MockDatabaseResult {
  const { tokensResult = [], insertErrorAfterCalls = 0, insertError, executeResult = [] } = options;

  let upsertCallCount = 0;

  const returning = vi.fn().mockResolvedValue([]);

  const onConflictDoUpdate = vi.fn().mockImplementation(() => {
    upsertCallCount++;
    if (insertError && upsertCallCount > insertErrorAfterCalls) throw insertError;
    return { returning };
  });

  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);

  const values = vi.fn().mockReturnValue({
    onConflictDoNothing,
    onConflictDoUpdate,
  });

  const insertFn = vi.fn().mockReturnValue({ values });

  const limit = vi.fn().mockResolvedValue(tokensResult);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const selectFn = vi.fn().mockReturnValue({ from });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  const execute = vi.fn().mockResolvedValue(executeResult);

  const spies: MockDatabaseSpies = {
    select: selectFn,
    from,
    where,
    limit,
    insert: insertFn,
    values,
    onConflictDoNothing,
    onConflictDoUpdate,
    returning,
    deleteFn,
    deleteWhere,
    execute,
  };

  // Build the db object that structurally satisfies SyncDatabase.
  // We use a function-typed variable so TypeScript infers the mock
  // return values' chain types without needing type assertions.
  const db: SyncDatabase = {
    select: selectFn,
    insert: insertFn,
    delete: deleteFn,
    execute,
  };

  return { db, spies };
}
