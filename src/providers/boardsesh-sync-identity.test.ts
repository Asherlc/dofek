import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BoardSeshProvider } from "./boardsesh.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import {
  boardSeshGradeAscentFixture,
  createBoardSeshMetadataFetch,
  createMockDatabase,
} from "./test-helpers.ts";

const databaseMocks = vi.hoisted(() => ({
  loadTokens: vi.fn(),
  persistSnapshot: vi.fn(),
}));

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn(),
  loadTokens: databaseMocks.loadTokens,
  saveTokens: vi.fn(),
}));
vi.mock("../db/climbing-log-snapshot.ts", () => ({
  persistClimbingLogSnapshot: databaseMocks.persistSnapshot,
}));
vi.mock("../db/climbing-log-sync.ts", () => ({ persistClimbingLogEntries: vi.fn() }));
vi.mock("../db/sync-log.ts", () => ({
  withSyncLog: async (
    _db: unknown,
    _id: string,
    _type: string,
    operation: () => Promise<{ result: number }>,
  ) => (await operation()).result,
}));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));

const renderBoard = { layoutId: 11, sizeId: 5, setIds: [1, 20] };
const tick = (overrides: Record<string, unknown> = {}) => ({
  uuid: "tick-1",
  userId: "owner-1",
  boardType: "kilter",
  climbUuid: "climb-1",
  climbRevision: null,
  angle: 40,
  isMirror: false,
  status: "flash",
  attemptCount: 1,
  quality: 4,
  difficulty: 19,
  isBenchmark: false,
  comment: "",
  climbedAt: "2026-11-01 10:00:00",
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T10:00:00Z",
  sessionId: null,
  auroraType: null,
  auroraId: null,
  auroraSyncedAt: null,
  layoutId: 11,
  boardId: null,
  boardDisplayName: null,
  ...overrides,
});
const ascent = (overrides: Record<string, unknown> = {}) =>
  boardSeshGradeAscentFixture({ boardId: null, layoutId: 11, renderBoard, ...overrides });

async function sync(
  options: {
    tickOverrides?: Record<string, unknown>;
    ascentOverrides?: Record<string, unknown>;
    lookup?: Record<string, unknown> | null;
    stored?: Record<string, unknown> | null;
  } = {},
) {
  const base = createBoardSeshMetadataFetch({
    ticks: [tick(options.tickOverrides)],
    grades: [{ difficultyId: 19, name: "6b+/V4" }],
    pages: { 0: { items: [ascent(options.ascentOverrides)], hasMore: false } },
  });
  const lookups: Array<Record<string, unknown>> = [];
  const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
    const body = z
      .object({ query: z.string(), variables: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(String(init?.body)));
    if (!body.query.includes("BoardSeshClimbLookup")) return base(input, init);
    lookups.push(body.variables);
    return Response.json({
      data: {
        authenticatedUserId: "owner-1",
        c0:
          options.lookup === undefined
            ? { uuid: "canonical-1", boardType: "kilter", layoutId: 11 }
            : options.lookup,
      },
    });
  });
  const storedRaw =
    options.stored === undefined || options.stored === null
      ? []
      : [{ external_id: "boardsesh:tick:tick-1", raw: { metadata: { ascent: options.stored } } }];
  const { db } = createMockDatabase({ executeResult: storedRaw });
  await new BoardSeshProvider(fetchFn).sync(
    new SyncRun({
      db,
      userId: "00000000-0000-4000-8000-000000000001",
      window: SyncWindow.full(),
    }),
  );
  const { entries } = z
    .object({ entries: z.array(z.object({ raw: z.record(z.string(), z.unknown()) })) })
    .parse(databaseMocks.persistSnapshot.mock.calls[0]?.[1]);
  const canonical = z
    .object({ metadata: z.object({ ascent: z.record(z.string(), z.unknown()) }) })
    .parse(entries[0]?.raw).metadata.ascent.canonicalClimbUuid;
  return { lookups, canonical };
}

describe("BoardSesh sync climb identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    databaseMocks.persistSnapshot.mockImplementation(
      async (_tx: unknown, input: { entries: unknown[] }) => ({
        recordsSynced: input.entries.length,
      }),
    );
    databaseMocks.loadTokens.mockResolvedValue({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 60_000),
      scopes: null,
      providerAccountId: "owner-1",
    });
  });

  it.each(["flash", "send"])(
    "verifies a completed %s with the climb configuration",
    async (status) => {
      const { lookups, canonical } = await sync({ tickOverrides: { status } });
      expect(lookups).toEqual([{ b0: "kilter", l0: 11, s0: 5, t0: "1,20", a0: 40, u0: "climb-1" }]);
      expect(canonical).toBe("canonical-1");
    },
  );

  it.each([
    ["an attempt", { tickOverrides: { status: "attempt" } }],
    ["no consensus grade", { ascentOverrides: { consensusDifficulty: null } }],
    ["no layout", { ascentOverrides: { layoutId: null } }],
    [
      "a zero layout",
      { ascentOverrides: { layoutId: 0, renderBoard: { ...renderBoard, layoutId: 0 } } },
    ],
    ["no render board", { ascentOverrides: { renderBoard: null } }],
    [
      "a different render layout",
      { ascentOverrides: { renderBoard: { ...renderBoard, layoutId: 12 } } },
    ],
    ["a zero size", { ascentOverrides: { renderBoard: { ...renderBoard, sizeId: 0 } } }],
  ])("does not look up an identity for %s", async (_name, options) => {
    const { lookups, canonical } = await sync(options);
    expect(lookups).toEqual([]);
    expect(canonical).toBeUndefined();
  });

  it("leaves the identity unresolved when BoardSesh has no canonical climb", async () => {
    const { lookups, canonical } = await sync({ lookup: null });
    expect(lookups).toHaveLength(1);
    expect(canonical).toBeUndefined();
  });

  describe("when a lookup does not return an identity", () => {
    const stored = { boardType: "kilter", climbUuid: "climb-1", canonicalClimbUuid: "kept-1" };

    it("keeps the previously verified ID for the same source climb", async () => {
      const { canonical } = await sync({ lookup: null, stored });
      expect(canonical).toBe("kept-1");
    });

    it("keeps the previously verified ID when BoardSesh is unavailable", async () => {
      const { canonical } = await sync({ lookup: { uuid: 1 }, stored });
      expect(canonical).toBe("kept-1");
    });

    it("prefers a freshly verified ID over the stored one", async () => {
      const { canonical } = await sync({ stored });
      expect(canonical).toBe("canonical-1");
    });

    it.each([
      ["a different problem", { ...stored, climbUuid: "other-climb" }],
      ["a different board", { ...stored, boardType: "tension" }],
      ["a blank ID", { ...stored, canonicalClimbUuid: "  " }],
      ["no stored ID", { boardType: "kilter", climbUuid: "climb-1" }],
    ])("does not reuse a stored ID from %s", async (_name, row) => {
      const { canonical } = await sync({ lookup: null, stored: row });
      expect(canonical).toBeUndefined();
    });
  });
});
