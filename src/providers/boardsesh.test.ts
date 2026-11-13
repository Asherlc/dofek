import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BoardSeshProvider } from "./boardsesh.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createMockDatabase } from "./test-helpers.ts";

const databaseMocks = vi.hoisted(() => ({
  ensureProvider: vi.fn(),
  loadTokens: vi.fn(),
  saveTokens: vi.fn(),
  persistSnapshot: vi.fn(),
  persistEntries: vi.fn(),
}));

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: databaseMocks.ensureProvider,
  loadTokens: databaseMocks.loadTokens,
  saveTokens: databaseMocks.saveTokens,
}));
vi.mock("../db/climbing-log-snapshot.ts", () => ({
  persistClimbingLogSnapshot: databaseMocks.persistSnapshot,
}));
vi.mock("../db/climbing-log-sync.ts", () => ({
  persistClimbingLogEntries: databaseMocks.persistEntries,
}));
vi.mock("../db/sync-log.ts", () => ({
  withSyncLog: async (
    _db: unknown,
    _id: string,
    _type: string,
    operation: () => Promise<{ result: number }>,
  ) => (await operation()).result,
}));

const validTokenResponse = {
  jwt: "access",
  refreshToken: "refresh",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const syncUserId = "00000000-0000-4000-8000-000000000001";
const makeTick = (overrides: Record<string, unknown> = {}) => ({
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
  effectiveQuality: 5,
  difficulty: 20,
  effectiveDifficulty: 21,
  isBenchmark: true,
  comment: "",
  climbedAt: "2026-11-01 10:00:00",
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T10:00:00Z",
  sessionId: null,
  auroraType: null,
  auroraId: null,
  auroraSyncedAt: null,
  layoutId: 7,
  boardId: null,
  boardDisplayName: null,
  ...overrides,
});

function syncRun(provider: BoardSeshProvider, signal?: AbortSignal) {
  const { db } = createMockDatabase();
  return provider.sync(new SyncRun({ db, userId: syncUserId, window: SyncWindow.full(), signal }));
}

describe("BoardSeshProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    databaseMocks.persistSnapshot.mockResolvedValue({ recordsSynced: 0 });
    databaseMocks.persistSnapshot.mockImplementation(
      async (_tx: unknown, input: { entries: unknown[] }) => ({
        recordsSynced: input.entries.length,
      }),
    );
  });

  it("logs in with email and password and binds the verified account ID", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new BoardSeshProvider(async (input, init) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/auth/native/credentials"))
        return Response.json(validTokenResponse);
      return Response.json({ data: { authenticatedUserId: "owner-1" } });
    });

    const tokens = await provider.authSetup().automatedLogin?.("climber@example.com", "secret");

    expect(requests[0]).toMatchObject({
      url: "https://ws.boardsesh.com/auth/native/credentials",
      init: {
        method: "POST",
        body: JSON.stringify({ email: "climber@example.com", password: "secret" }),
      },
    });
    expect(tokens).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      providerAccountId: "owner-1",
    });
  });

  it("does not expose upstream bodies for rejected credentials", async () => {
    const provider = new BoardSeshProvider(
      async () => new Response("private detail", { status: 401 }),
    );
    await expect(
      provider.authSetup().automatedLogin?.("climber@example.com", "secret"),
    ).rejects.toThrow(/BoardSesh.*password/i);
    await expect(
      provider.authSetup().automatedLogin?.("climber@example.com", "secret"),
    ).rejects.not.toThrow("private detail");
  });

  it.each([400, 401, 403])(
    "treats HTTP %s login rejection as credential failure",
    async (status) => {
      const provider = new BoardSeshProvider(async () => new Response("private", { status }));
      await expect(
        provider.authSetup().automatedLogin?.("climber@example.com", "secret"),
      ).rejects.toThrow(/password/i);
    },
  );

  it("reports non-credential login statuses without returning upstream details", async () => {
    const provider = new BoardSeshProvider(async () => new Response("private", { status: 422 }));
    await expect(
      provider.authSetup().automatedLogin?.("climber@example.com", "secret"),
    ).rejects.toThrow("HTTP 422");
    await expect(
      provider.authSetup().automatedLogin?.("climber@example.com", "secret"),
    ).rejects.not.toThrow("private");
  });

  it("rejects invalid token expiries without exposing the response body", async () => {
    const provider = new BoardSeshProvider(async () =>
      Response.json({
        ...validTokenResponse,
        expiresAt: "not-a-date",
        privateDetail: "must not appear",
      }),
    );
    await expect(
      provider.authSetup().automatedLogin?.("climber@example.com", "secret"),
    ).rejects.toThrow(/expiry|token/i);
    await expect(
      provider.authSetup().automatedLogin?.("climber@example.com", "secret"),
    ).rejects.not.toThrow("must not appear");
  });

  it.each([
    ["missing", undefined],
    ["expired", new Date(0).toISOString()],
  ])("rejects a %s login expiry", async (_description, expiresAt) => {
    const provider = new BoardSeshProvider(async () =>
      Response.json({ ...validTokenResponse, expiresAt }),
    );
    await expect(
      provider.authSetup().automatedLogin?.("climber@example.com", "secret"),
    ).rejects.toThrow(/expiry|token/i);
  });

  it("persists a rotated token before the next public sync read and snapshots only after all boards validate", async () => {
    const order: string[] = [];
    const oldTokens = {
      accessToken: "expired",
      refreshToken: "old-refresh",
      expiresAt: new Date(0),
      scopes: "profile",
      providerAccountId: "owner-1",
    };
    databaseMocks.loadTokens.mockResolvedValue(oldTokens);
    databaseMocks.saveTokens.mockImplementation(async () => {
      order.push("persist");
    });
    const provider = new BoardSeshProvider(async (input, init) => {
      if (String(input).endsWith("/auth/native/refresh")) {
        order.push("refresh");
        return Response.json({
          ...validTokenResponse,
          jwt: "rotated",
          refreshToken: "rotated-refresh",
        });
      }
      order.push("graphql");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rotated");
      const body = z.object({ query: z.string() }).parse(JSON.parse(String(init?.body)));
      if (body.query.includes("grades"))
        return Response.json({ data: { authenticatedUserId: "owner-1", grades: [] } });
      return Response.json({ data: { authenticatedUserId: "owner-1", ticks: [] } });
    });
    const result = await syncRun(provider);

    expect(result).toMatchObject({ recordsSynced: 0, errors: [] });
    expect(order.slice(0, 3)).toEqual(["refresh", "persist", "graphql"]);
    expect(databaseMocks.saveTokens.mock.calls[0]?.[2]).toMatchObject({
      scopes: "profile",
      providerAccountId: "owner-1",
    });
    expect(order.filter((step) => step === "graphql")).toHaveLength(18);
    expect(databaseMocks.persistSnapshot).toHaveBeenCalledOnce();
  });

  it("maps only personal grades and source statuses while keeping mirrored climbs distinct", async () => {
    databaseMocks.loadTokens.mockResolvedValue({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 60_000),
      scopes: null,
      providerAccountId: "owner-1",
    });
    const requests: Array<{
      url: string;
      method: string | undefined;
      headers: Headers;
      signal?: AbortSignal | null;
      body: string;
    }> = [];
    const controller = new AbortController();
    const provider = new BoardSeshProvider(async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
        headers: new Headers(init?.headers),
        signal: init?.signal,
        body: String(init?.body),
      });
      const body = z
        .object({
          query: z.string(),
          variables: z.object({ input: z.object({ boardType: z.string() }).optional() }).optional(),
        })
        .parse(JSON.parse(String(init?.body)));
      if (body.query.includes("grades"))
        return Response.json({
          data: {
            authenticatedUserId: "owner-1",
            grades: [
              { difficultyId: 20, name: "6c/V5" },
              { difficultyId: 22, name: "Unknown grade" },
            ],
          },
        });
      const rows =
        body.variables?.input?.boardType === "kilter"
          ? [
              makeTick(),
              makeTick({
                uuid: "tick-send",
                isMirror: true,
                status: "send",
                attemptCount: 3,
                difficulty: 22,
                comment: "  repeat send  ",
              }),
              makeTick({
                uuid: "tick-attempt",
                climbUuid: "climb-attempt",
                status: "attempt",
                attemptCount: 2,
                difficulty: null,
              }),
            ]
          : [];
      return Response.json({ data: { authenticatedUserId: "owner-1", ticks: rows } });
    });

    const result = await syncRun(provider, controller.signal);
    const input = z
      .object({ entries: z.array(z.record(z.string(), z.unknown())) })
      .parse(databaseMocks.persistSnapshot.mock.calls[0]?.[1]);
    expect(result).toMatchObject({ recordsSynced: 3, errors: [] });
    expect(requests).toHaveLength(18);
    expect(
      requests.every(
        ({ url, method, headers, signal }) =>
          url === "https://ws.boardsesh.com/graphql" &&
          method === "POST" &&
          headers.get("authorization") === "Bearer access" &&
          headers.get("content-type") === "application/json" &&
          signal instanceof AbortSignal,
      ),
    ).toBe(true);
    expect(requests.map(({ body }) => JSON.parse(body).query).join(" ")).toContain(
      "ticks(input: $input)",
    );
    expect(requests.map(({ body }) => JSON.parse(body).query).join(" ")).toContain(
      "grades(boardName: $boardName)",
    );
    controller.abort();
    expect(requests.every(({ signal }) => signal?.aborted)).toBe(true);
    expect(input.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: "boardsesh:tick:tick-1",
          wallAngle: { value: 40, unit: "degrees" },
          board: null,
          raw: expect.objectContaining({
            uuid: "tick-1",
            isMirror: false,
            quality: 4,
            difficulty: 20,
            isBenchmark: true,
            layoutId: 7,
            boardId: null,
          }),
          reportedGrades: [
            { value: "6c", system: "font" },
            { value: "V5", system: "v_scale" },
          ],
          attempts: [
            {
              scope: "climb",
              sourceCompleted: true,
              sourceResult: "flash",
              qualifier: "free-flash",
            },
          ],
        }),
        expect.objectContaining({
          externalId: "boardsesh:tick:tick-send",
          reportedGrades: [],
          climb: expect.objectContaining({ externalId: "kilter:climb-1:mirror" }),
          notes: "repeat send",
          attempts: [
            { scope: "climb", sourceCompleted: true, sourceResult: "send", qualifier: "free-send" },
          ],
          reportedAttemptCounts: [{ scope: "climb", count: 3 }],
        }),
        expect.objectContaining({
          externalId: "boardsesh:tick:tick-attempt",
          attempts: [{ scope: "climb", sourceCompleted: false, sourceResult: "attempt" }],
          reportedAttemptCounts: [{ scope: "climb", count: 2 }],
        }),
      ]),
    );
  });

  it("validates GraphQL HTTP status, response shape, and mixed error classes without retrying", async () => {
    const tokens = {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 60_000),
      scopes: null,
      providerAccountId: "owner-1",
    };
    const scenarios: Array<[string, () => Response, number]> = [
      ["HTTP unauthorized", () => new Response("private", { status: 401 }), 1],
      ["HTTP forbidden", () => new Response("private", { status: 403 }), 1],
      ["HTTP not found", () => new Response("private", { status: 404 }), 0],
      ["HTTP unprocessable", () => new Response("private", { status: 422 }), 0],
      ["missing data", () => Response.json({}), 0],
      [
        "malformed data",
        () => Response.json({ data: { authenticatedUserId: "owner-1", ticks: "bad" } }),
        0,
      ],
      [
        "mixed auth and server errors",
        () =>
          Response.json({
            data: null,
            errors: [
              { message: "Authentication required" },
              { message: "temporarily unavailable" },
            ],
          }),
        0,
      ],
    ];
    for (const [name, response, expectedRefreshes] of scenarios) {
      databaseMocks.loadTokens.mockResolvedValue(tokens);
      const refreshes: string[] = [];
      const provider = new BoardSeshProvider(async (input) => {
        if (String(input).endsWith("/auth/native/refresh")) {
          refreshes.push("refresh");
          return Response.json(validTokenResponse);
        }
        return response();
      });
      const result = await syncRun(provider);
      expect(result.errors, name).toHaveLength(1);
      expect(databaseMocks.persistSnapshot, name).not.toHaveBeenCalled();
      expect(refreshes, name).toHaveLength(expectedRefreshes);
    }
  });

  it("normalizes source timezone offsets and preserves unmapped personal grades and counts", async () => {
    databaseMocks.loadTokens.mockResolvedValue({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 60_000),
      scopes: null,
      providerAccountId: "owner-1",
    });
    const provider = new BoardSeshProvider(async (_input, init) => {
      const body = z
        .object({
          query: z.string(),
          variables: z.object({ input: z.object({ boardType: z.string() }).optional() }).optional(),
        })
        .parse(JSON.parse(String(init?.body)));
      if (body.query.includes("grades"))
        return Response.json({
          data: {
            authenticatedUserId: "owner-1",
            grades: [
              { difficultyId: 20, name: " 6c / V5 " },
              { difficultyId: 21, name: "6c/V5/X" },
            ],
          },
        });
      const rows =
        body.variables?.input?.boardType === "kilter"
          ? [
              makeTick({ uuid: "offset", climbedAt: "2026-11-01 10:00:00-07:00", difficulty: 999 }),
              makeTick({ uuid: "grade", climbedAt: "2026-11-01 10:00:00Z", difficulty: 20 }),
              makeTick({ uuid: "multi-grade", climbedAt: "2026-11-01 10:00:00Z", difficulty: 21 }),
            ]
          : [];
      return Response.json({ data: { authenticatedUserId: "owner-1", ticks: rows } });
    });
    const result = await syncRun(provider);
    const input = z
      .object({ entries: z.array(z.record(z.string(), z.unknown())) })
      .parse(databaseMocks.persistSnapshot.mock.calls[0]?.[1]);
    expect(result.errors).toEqual([]);
    expect(input.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: "boardsesh:tick:offset",
          activityObservation: { recordedAt: "2026-11-01T17:00:00.000Z" },
          reportedGrades: [],
          reportedAttemptCounts: [{ scope: "climb", count: 1 }],
        }),
        expect.objectContaining({
          externalId: "boardsesh:tick:grade",
          reportedGrades: [
            { value: "6c", system: "font" },
            { value: "V5", system: "v_scale" },
          ],
        }),
        expect.objectContaining({ externalId: "boardsesh:tick:multi-grade", reportedGrades: [] }),
      ]),
    );
  });

  it("refreshes when expiry is exactly the current instant", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    databaseMocks.loadTokens.mockResolvedValue({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(now),
      scopes: null,
      providerAccountId: "owner-1",
    });
    const requests: string[] = [];
    const provider = new BoardSeshProvider(async (input, init) => {
      requests.push(String(input));
      if (String(input).endsWith("/auth/native/refresh")) return Response.json(validTokenResponse);
      const body = z.object({ query: z.string() }).parse(JSON.parse(String(init?.body)));
      return body.query.includes("grades")
        ? Response.json({ data: { authenticatedUserId: "owner-1", grades: [] } })
        : Response.json({ data: { authenticatedUserId: "owner-1", ticks: [] } });
    });
    const result = await syncRun(provider);
    expect(result.errors).toEqual([]);
    expect(requests[0]).toContain("/auth/native/refresh");
    vi.restoreAllMocks();
  });

  it("refreshes one explicit HTTP 200 auth rejection and does not loop on rejection", async () => {
    databaseMocks.loadTokens.mockResolvedValue({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 60_000),
      scopes: null,
      providerAccountId: "owner-1",
    });
    let tickRequests = 0;
    let refreshRequests = 0;
    const provider = new BoardSeshProvider(async (input, init) => {
      if (String(input).endsWith("/auth/native/refresh")) {
        refreshRequests++;
        return Response.json({
          ...validTokenResponse,
          jwt: "rotated",
          refreshToken: "rotated-refresh",
        });
      }
      const body = z.object({ query: z.string() }).parse(JSON.parse(String(init?.body)));
      tickRequests++;
      return body.query.includes("ticks")
        ? Response.json({ data: null, errors: [{ message: "Authentication required" }] })
        : Response.json({ data: { authenticatedUserId: "owner-1", grades: [] } });
    });

    const result = await syncRun(provider);
    expect(result.errors[0]?.message).toMatch(/reconnect/i);
    expect(tickRequests).toBe(2);
    expect(refreshRequests).toBe(1);
    expect(databaseMocks.persistSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing refresh token",
      {
        accessToken: "expired",
        refreshToken: null,
        expiresAt: new Date(0),
        scopes: null,
        providerAccountId: "owner-1",
      },
      /reconnect/i,
    ],
    [
      "generic GraphQL error",
      {
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: new Date(Date.now() + 60_000),
        scopes: null,
        providerAccountId: "owner-1",
      },
      /GraphQL/i,
    ],
  ])("fails safely for %s without saving a snapshot", async (_scenario, tokens, expected) => {
    databaseMocks.loadTokens.mockResolvedValue(tokens);
    const provider = new BoardSeshProvider(async (_input, init) => {
      const body = z.object({ query: z.string() }).parse(JSON.parse(String(init?.body)));
      return body.query.includes("ticks")
        ? Response.json({ data: null, errors: [{ message: "private upstream detail" }] })
        : Response.json({ data: { authenticatedUserId: "owner-1", grades: [] } });
    });
    const result = await syncRun(provider);
    expect(result.errors[0]?.message).toMatch(expected);
    expect(result.errors[0]?.message).not.toContain("private upstream detail");
    expect(databaseMocks.persistSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["foreign owner", makeTick({ userId: "other-owner" })],
    ["wrong board", makeTick({ boardType: "tension" })],
    ["malformed date", makeTick({ climbedAt: "2026-02-31 10:00:00" })],
    ["zero attempt count", makeTick({ attemptCount: 0 })],
  ])("rejects a %s tick before saving snapshot reconciliation", async (_scenario, invalidTick) => {
    databaseMocks.loadTokens.mockResolvedValue({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 60_000),
      scopes: null,
      providerAccountId: "owner-1",
    });
    const provider = new BoardSeshProvider(async (_input, init) => {
      const body = z
        .object({
          query: z.string(),
          variables: z.object({ input: z.object({ boardType: z.string() }).optional() }).optional(),
        })
        .parse(JSON.parse(String(init?.body)));
      return body.query.includes("ticks")
        ? Response.json({
            data: {
              authenticatedUserId: "owner-1",
              ticks: body.variables?.input?.boardType === "kilter" ? [invalidTick] : [],
            },
          })
        : Response.json({ data: { authenticatedUserId: "owner-1", grades: [] } });
    });
    const result = await syncRun(provider);
    expect(result.errors).toHaveLength(1);
    expect(databaseMocks.persistSnapshot).not.toHaveBeenCalled();
  });

  it.each(["changed account identity", "duplicate UUID"] as const)(
    "rejects a %s response before snapshot persistence",
    async (invalidCase) => {
      databaseMocks.loadTokens.mockResolvedValue({
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: new Date(Date.now() + 60_000),
        scopes: null,
        providerAccountId: "owner-1",
      });
      const provider = new BoardSeshProvider(async (_input, init) => {
        const body = z
          .object({
            query: z.string(),
            variables: z
              .object({ input: z.object({ boardType: z.string() }).optional() })
              .optional(),
          })
          .parse(JSON.parse(String(init?.body)));
        const accountId = invalidCase === "changed account identity" ? "owner-2" : "owner-1";
        const ticks =
          invalidCase === "duplicate UUID" && body.variables?.input?.boardType === "kilter"
            ? [makeTick(), makeTick()]
            : [];
        return body.query.includes("ticks")
          ? Response.json({ data: { authenticatedUserId: accountId, ticks } })
          : Response.json({ data: { authenticatedUserId: accountId, grades: [] } });
      });

      const result = await syncRun(provider);
      expect(result.errors).toHaveLength(1);
      expect(databaseMocks.persistSnapshot).not.toHaveBeenCalled();
    },
  );
});
