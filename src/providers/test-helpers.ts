/**
 * Shared test helpers for provider unit tests.
 *
 * Provides a `createMockDatabase()` factory that returns a properly typed
 * `SyncDatabase` mock — eliminating the need for type suppression
 * comments throughout provider test files.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { vi } from "vitest";
import { z } from "zod";
import { drizzleSchema } from "../db/drizzle-schema.ts";
import type { SyncDatabase, TransactionDatabase } from "../db/index.ts";
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
import type { MetricStreamEventPublisher } from "../metric-stream/publisher.ts";

export const OPENBETA_TEST_USER_UUID = "00000000-0000-0000-0000-000000000002";

export function boardSeshAscentFixture(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "tick-1",
    climbUuid: "climb-1",
    boardType: "kilter",
    isMirror: false,
    climbName: "  Moon Dust  ",
    boardId: 42,
    boardDisplayName: " Display board ",
    ...overrides,
  };
}

export function boardSeshBoardFixture(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "board-42",
    name: "Training Kilter",
    boardType: "kilter",
    locationName: " Movement Sunnyvale ",
    gymName: null,
    latitude: 37.37,
    longitude: -122.04,
    ...overrides,
  };
}

export const boardSeshMetadataCases = [
  [
    "gym name",
    {},
    { locationName: " ", gymName: " Gym name ", latitude: null, longitude: null },
    "available",
    {
      name: "Moon Dust",
      board: { name: "Training Kilter", externalId: "board-42" },
      areas: [{ externalId: "board:board-42", name: "Gym name", coordinates: null }],
    },
  ],
  [
    "coordinate-only board at zero",
    {},
    { locationName: null, gymName: null, latitude: 0, longitude: 0 },
    "available",
    {
      name: "Moon Dust",
      board: { name: "Training Kilter", externalId: "board-42" },
      areas: [
        {
          externalId: "board:board-42",
          name: "Training Kilter",
          coordinates: { latitude: 0, longitude: 0 },
        },
      ],
    },
  ],
  [
    "missing latitude",
    {},
    { latitude: null, longitude: 0 },
    "available",
    {
      name: "Moon Dust",
      board: { name: "Training Kilter", externalId: "board-42" },
      areas: [{ name: "Movement Sunnyvale", coordinates: null }],
    },
  ],
  [
    "missing longitude",
    {},
    { latitude: 0, longitude: null },
    "available",
    {
      name: "Moon Dust",
      board: { name: "Training Kilter", externalId: "board-42" },
      areas: [{ name: "Movement Sunnyvale", coordinates: null }],
    },
  ],
  [
    "unknown location",
    {},
    { locationName: null, gymName: null, latitude: null, longitude: null },
    "available",
    {
      name: "Moon Dust",
      board: { name: "Training Kilter", externalId: "board-42" },
      areas: [],
    },
  ],
  [
    "inaccessible board",
    {},
    {},
    "inaccessible",
    { name: "Moon Dust", board: { name: "Display board", externalId: null }, areas: [] },
  ],
  [
    "deleted board",
    {},
    {},
    "deleted",
    { name: "Moon Dust", board: { name: "Display board", externalId: null }, areas: [] },
  ],
  [
    "unattributed board",
    { boardId: null, boardDisplayName: null },
    {},
    "available",
    { name: "Moon Dust", board: null, areas: [] },
  ],
  [
    "recorded display name only",
    { boardId: null, boardDisplayName: " Shared wall " },
    {},
    "available",
    { name: "Moon Dust", board: { name: "Shared wall", externalId: null }, areas: [] },
  ],
  [
    "unavailable display name",
    { boardDisplayName: null },
    {},
    "inaccessible",
    { name: "Moon Dust", board: null, areas: [] },
  ],
  [
    "unknown climb name",
    { climbName: "Unknown Climb" },
    {},
    "available",
    {
      name: null,
      board: { name: "Training Kilter", externalId: "board-42" },
      areas: [{ name: "Movement Sunnyvale" }],
    },
  ],
  [
    "blank climb name",
    { climbName: "   " },
    {},
    "available",
    {
      name: null,
      board: { name: "Training Kilter", externalId: "board-42" },
      areas: [{ name: "Movement Sunnyvale" }],
    },
  ],
] as const;

export function createBoardSeshMetadataFetch({
  ticks,
  pages,
  currentBoard = { uuid: "board-42", name: "Training Kilter", boardType: "kilter" },
  board = boardSeshBoardFixture(),
}: {
  ticks: unknown[];
  pages: Record<number, unknown>;
  currentBoard?: unknown;
  board?: unknown;
}) {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const { query, variables } = z
      .object({
        query: z.string(),
        variables: z.record(z.string(), z.unknown()),
      })
      .parse(JSON.parse(String(init?.body)));
    let data: Record<string, unknown>;
    if (query.includes("BoardSeshTicks")) {
      const input = z.object({ boardType: z.string() }).parse(variables.input);
      data = { ticks: input.boardType === "kilter" ? ticks : [] };
    } else if (query.includes("BoardSeshGrades")) {
      data = { grades: [] };
    } else if (query.includes("BoardSeshMetadata")) {
      const input = z.object({ offset: z.number() }).parse(variables.input);
      if (!(input.offset in pages)) throw new Error("Unexpected metadata page");
      data = { userAscentsFeed: pages[input.offset] };
    } else if (query.includes("BoardSeshTickBoard")) {
      data = { tickBoardOptions: { currentBoard } };
    } else if (query.includes("BoardSeshBoard")) {
      data = { board };
    } else {
      throw new Error("Unexpected BoardSesh operation");
    }
    return Response.json({ data: { authenticatedUserId: "owner-1", ...data } });
  });
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

export function kayaClimbFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "2001",
    name: "Test problem",
    lead: false,
    climb_type: { id: "1", name: "Bouldering" },
    grade: { id: "6", name: "V4", climb_type_group: "boulder" },
    gym: { id: "4001", name: "Test Gym", latitude: 0, longitude: -122.25 },
    destination: null,
    area: null,
    subarea: null,
    board: null,
    angle: null,
    tags: [],
    ...overrides,
  };
}
export function kayaAscentFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "3001",
    session_id: "1000",
    date: "2026-08-01T10:30:00Z",
    attempts: null,
    grade: null,
    ascent_type: { id: "flash", name: "Flash" },
    climb: kayaClimbFixture(),
    ...overrides,
  };
}
export function kayaSessionFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "1000",
    start_time: "2026-08-01T10:00:00Z",
    end_time: "2026-08-01T11:00:00Z",
    gym: { id: "4001", name: "Test Gym", latitude: 0, longitude: -122.25 },
    attempted_climbs: [],
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
    climbId: "climb-uuid-1",
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

export function makeTransactionalTestDatabase<
  TDatabase extends Omit<SyncDatabase, "transaction"> &
    Partial<Pick<TransactionDatabase, "query" | "update">>,
>(database: TDatabase): TDatabase & TransactionDatabase {
  const transaction: SyncDatabase["transaction"] = async (work) => work(transactionDb);
  const transactionDb = Object.assign(database, {
    query: database.query ?? drizzle.mock({ schema: drizzleSchema }).query,
    update: database.update ?? vi.fn(),
    transaction,
  });
  return transactionDb;
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
  const db = makeTransactionalTestDatabase({
    select: selectFn,
    insert: insertFn,
    delete: deleteFn,
    execute,
  });

  return { db, spies };
}
