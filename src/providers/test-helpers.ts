/**
 * Shared test helpers for provider unit tests.
 *
 * Provides a `createMockDatabase()` factory that returns a properly typed
 * `SyncDatabase` mock — eliminating the need for type suppression
 * comments throughout provider test files.
 */
import { sql } from "drizzle-orm";
import { vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import type {
  ProviderDataGenerationContext,
  ProviderDataScope,
} from "../db/provider-data-deletion.ts";
import type { Database } from "../db/typed-sql.ts";
import {
  createMetricStreamDeletedEvent,
  createMetricStreamEvent,
  type MetricStreamEventV2,
  type MetricStreamRowInput,
} from "../metric-stream/events.ts";
import type { MetricStreamEventPublisher } from "../metric-stream/redpanda-producer.ts";

export const OPENBETA_TEST_USER_UUID = "00000000-0000-0000-0000-000000000002";

/** Synthetic fixtures for the published personal-logbook contract; not live API captures. */
export function theCragAscent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1001",
    epoch: 1791676800,
    date: "2026-10-10",
    logDate: "2026-10-11",
    climbedGearStyle: "sport",
    tick: { label: "redpoint", name: "Redpoint" },
    markdown: "Personal ascent notes",
    historical: false,
    cpr: null,
    cprStyle: "sport",
    tags: [],
    pitch: [],
    route: {
      id: "2001",
      name: "Sunset Arete",
      grade: "5.10a",
      gradeBand: 3,
      gradeAtom: { grade: "5.10a", gradeBand: 3, type: "unverified-native-type" },
      style: "Sport",
      height: null,
      displayHeight: null,
      stars: 2,
      bolts: 8,
      urlAncestorStub: "/en/climbing/example-crag",
      ancestors: {
        country: { id: "3001", name: "United States", subType: "Country", depth: 1 },
        TLC: { id: "3002", name: "Example Crag", subType: "Crag", depth: 4 },
        parent: { id: "3003", name: "South Wall", subType: "Sector", depth: 5 },
      },
      tags: [],
    },
    ...overrides,
  };
}

export function theCragPage(
  ascents: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    data: {
      account: { id: "123", name: "Climber", login: "climber" },
      ascents,
      numberAscents: ascents.length,
      page: "1",
      perPage: 250,
      ...overrides,
    },
  };
}

export function openBetaGrades(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vscale: null,
    yds: "5.10a",
    ewbank: null,
    french: null,
    font: null,
    uiaa: null,
    brazilianCrux: null,
    ...overrides,
  };
}

export function openBetaClimb(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: "climb-uuid-1",
    name: "Sunset Arete",
    grades: openBetaGrades(),
    type: { bouldering: false, sport: null, trad: null },
    parent: { area_name: "Smith Rock" },
    ...overrides,
  };
}

export function openBetaTick(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: "tick-1",
    userId: OPENBETA_TEST_USER_UUID,
    name: "Sunset Arete",
    notes: "Great movement",
    climbId: "climb-1",
    style: "Lead",
    attemptType: "Redpoint",
    dateClimbed: 1786320000000,
    grade: "5.10a",
    source: "OB",
    user: { username: "climber", displayName: "Climber" },
    climb: openBetaClimb({ type: { trad: true, sport: false, bouldering: false } }),
    ...overrides,
  };
}

export function fakeJwt(expirationEpochSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expirationEpochSeconds })).toString(
    "base64url",
  );
  return `${header}.${payload}.signature`;
}

export async function resolveProviderDataGenerationsForTest(
  database: Database,
  scopes: readonly ProviderDataScope[],
): Promise<ProviderDataGenerationContext> {
  await database.execute(sql`SELECT 0 AS generation`);
  return {
    generations: scopes.map((scope) => ({ ...scope, generation: 0 })),
    operationRevision: "1000000000000000",
  };
}

export function makeTransactionalTestDatabase<TDatabase extends Database>(
  database: TDatabase,
): TDatabase & {
  transaction<TResult>(work: (transaction: TDatabase) => Promise<TResult>): Promise<TResult>;
} {
  async function transaction<TResult>(
    work: (transaction: TDatabase) => Promise<TResult>,
  ): Promise<TResult> {
    return work(database);
  }
  return Object.assign(database, { transaction });
}

/**
 * Options for configuring the mock database behavior.
 */
export interface MockDatabaseOptions {
  /** Rows returned by `select().from().where().limit()` (default: []) */
  tokensResult?: Record<string, unknown>[];
  /** Number of upsert calls to allow before throwing `insertError` */
  insertErrorAfterCalls?: number;
  /** Error to throw from conflict insert handlers after `insertErrorAfterCalls` calls */
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

export interface CapturingMetricStreamPublisher {
  publisher: MetricStreamEventPublisher;
  publishedMetricStreamRows: MetricStreamRowInput[];
  deletedMetricStreamScopes: Parameters<
    NonNullable<MetricStreamEventPublisher["replaceRows"]>
  >[0][];
}

export function createCapturingMetricStreamPublisher(): CapturingMetricStreamPublisher {
  const publishedMetricStreamRows: MetricStreamRowInput[] = [];
  const deletedMetricStreamScopes: Parameters<
    NonNullable<MetricStreamEventPublisher["replaceRows"]>
  >[0][] = [];
  return {
    publishedMetricStreamRows,
    deletedMetricStreamScopes,
    publisher: {
      async publishRows(rows, options): Promise<MetricStreamEventV2[]> {
        publishedMetricStreamRows.push(...rows);
        return rows.map((row) => createMetricStreamEvent(row, options.operationRevision));
      },
      async replaceRows(scope, rows, operationRevision) {
        publishedMetricStreamRows.push(...rows);
        deletedMetricStreamScopes.push(scope);
        return {
          deleted: createMetricStreamDeletedEvent(scope, operationRevision),
          rows: rows.map((row) => createMetricStreamEvent(row, operationRevision)),
        };
      },
    },
  };
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
  const recordInsertAttempt = () => {
    upsertCallCount++;
    if (insertError && upsertCallCount > insertErrorAfterCalls) throw insertError;
  };

  const onConflictDoUpdate = vi.fn().mockImplementation(() => {
    recordInsertAttempt();
    return { returning };
  });

  const onConflictDoNothing = vi.fn().mockImplementation(() => {
    recordInsertAttempt();
    return undefined;
  });

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
  const db = makeTransactionalTestDatabase<SyncDatabase>({
    select: selectFn,
    insert: insertFn,
    delete: deleteFn,
    execute,
  });

  return { db, spies };
}
