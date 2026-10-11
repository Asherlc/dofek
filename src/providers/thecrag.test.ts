import { inspect } from "node:util";
import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
} from "@dofek/provider-http/rate-limit";
import { DrizzleQueryError, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authFailureReasonFromError, ProviderTokenRejectedError } from "./auth-errors.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createMockDatabase, theCragAscent, theCragPage } from "./test-helpers.ts";
import { TheCragProvider } from "./thecrag.ts";

const USER_ID = "00000000-0000-0000-0000-000000000001";
const ACCOUNT_ID = "123";
const mocks = vi.hoisted(() => ({
  ensureProvider: vi.fn().mockResolvedValue(undefined),
  loadTokens: vi.fn(),
  captureException: vi.fn(),
  withSyncLog: vi.fn(
    async (_database, _providerId, _dataType, callback) => (await callback()).result,
  ),
}));

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: mocks.ensureProvider,
  loadTokens: mocks.loadTokens,
}));
vi.mock("../db/sync-log.ts", () => ({ withSyncLog: mocks.withSyncLog }));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: mocks.captureException }));

function response(
  ascents: Record<string, unknown>[] = [],
  overrides: Record<string, unknown> = {},
): Response {
  return new Response(JSON.stringify(theCragPage(ascents, overrides)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function tokens(accountId = ACCOUNT_ID) {
  return {
    accessToken: "personal-key",
    refreshToken: null,
    expiresAt: new Date("2099-12-31T00:00:00.000Z"),
    scopes: "logbook:read",
    providerAccountId: accountId,
  };
}

function makeRun(
  database: ReturnType<typeof createMockDatabase>["db"],
  options: { full?: boolean; origin?: "scheduled" | "manual"; userId?: string } = {},
): SyncRun {
  return new SyncRun({
    db: database,
    window:
      options.full === false
        ? SyncWindow.fromDateRange({ sinceDate: "2026-10-01", untilDate: "2026-10-11" })
        : SyncWindow.full(new Date("2026-10-11T23:59:59.999Z")),
    userId: options.userId ?? USER_ID,
    origin: options.origin,
  });
}

function writtenRecords(mockDatabase: ReturnType<typeof createMockDatabase>): unknown {
  const statement = mockDatabase.spies.execute.mock.calls.at(-1)?.[0];
  if (!(statement instanceof SQL)) throw new Error("No climbing-record statement was written");
  const parameters = new PgDialect().sqlToQuery(statement).params;
  const encodedRecords = parameters.find(
    (parameter): parameter is string => typeof parameter === "string" && parameter.startsWith("[{"),
  );
  if (!encodedRecords) throw new Error("Climbing-record statement has no encoded records");
  return JSON.parse(encodedRecords);
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.loadTokens.mockResolvedValue(tokens());
});

mocks.loadTokens.mockResolvedValue(tokens());

describe("TheCragProvider personal key authentication", () => {
  it("validates the key against the logbook and retains its account identity", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response());
    const exchange = new TheCragProvider(fetchFn).authSetup().manualToken?.exchangeToken;
    if (!exchange) throw new Error("Personal key connection is unavailable");

    await expect(exchange(" personal-key ")).resolves.toMatchObject({
      accessToken: "personal-key",
      refreshToken: null,
      providerAccountId: "123",
      scopes: "logbook:read",
    });
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining("https://www.thecrag.com/api/logbook/ascents"),
      expect.objectContaining({
        headers: expect.objectContaining({ "X-CData-Key": "key=personal-key" }),
      }),
    );
  });

  it("explains verified key rejection and supporter prerequisites", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const exchange = new TheCragProvider(fetchFn).authSetup().manualToken?.exchangeToken;
    if (!exchange) throw new Error("Personal key connection is unavailable");
    await expect(exchange("personal-key")).rejects.toMatchObject({
      message: expect.stringMatching(/supporter/i),
      authFailureReason: "authentication_failed",
    });
  });

  it.each([null, "<html>Cloudflare blocked access</html>"])(
    "reports unclassified 403 access denial without requiring reconnection (%s)",
    async (body) => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 403 }));
      const exchange = new TheCragProvider(fetchFn).authSetup().manualToken?.exchangeToken;
      if (!exchange) throw new Error("Personal key connection is unavailable");
      const error = await exchange("personal-key").catch((rejection: unknown) => rejection);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ message: expect.stringMatching(/access.*denied.*403/i) });
      expect(authFailureReasonFromError(error)).toBeUndefined();
    },
  );

  it("rejects HTML login pages instead of saving an unverified key", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>Login</html>"));
    const exchange = new TheCragProvider(fetchFn).authSetup().manualToken?.exchangeToken;
    if (!exchange) throw new Error("Personal key connection is unavailable");
    await expect(exchange("personal-key")).rejects.toThrow();
  });

  it("rejects JSON without a logbook account identity", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response([], { account: {} }));
    const exchange = new TheCragProvider(fetchFn).authSetup().manualToken?.exchangeToken;
    if (!exchange) throw new Error("Personal key connection is unavailable");
    await expect(exchange("personal-key")).rejects.toThrow(/response/i);
  });

  it("does not send an empty personal key", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const exchange = new TheCragProvider(fetchFn).authSetup().manualToken?.exchangeToken;
    if (!exchange) throw new Error("Personal key connection is unavailable");
    await expect(exchange("  ")).rejects.toBeInstanceOf(ProviderTokenRejectedError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("preserves shared rate-limit errors", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: { "Retry-After": "1" },
      }),
    );
    const exchange = new TheCragProvider(fetchFn).authSetup().manualToken?.exchangeToken;
    if (!exchange) throw new Error("Personal key connection is unavailable");
    await expect(exchange("personal-key")).rejects.toBeInstanceOf(ProviderRateLimitError);
  });

  it.each([
    new DOMException("The operation was aborted.", "AbortError"),
    new ProviderRequestTimeoutError({ providerId: "thecrag", timeoutMs: 120_000 }),
  ])("preserves response-body abort or transport failure %s", async (failure) => {
    const body = response();
    vi.spyOn(body, "json").mockRejectedValue(failure);
    const exchange = new TheCragProvider(vi.fn<typeof fetch>().mockResolvedValue(body)).authSetup()
      .manualToken?.exchangeToken;
    if (!exchange) throw new Error("Personal key connection is unavailable");
    await expect(exchange("personal-key")).rejects.toBe(failure);
  });
});

describe("TheCragProvider logbook sync", () => {
  it("reports malformed JSON without leaking the upstream body to errors or telemetry", async () => {
    const body = "KEY123 NOTE456";
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 200 }));
    const database = createMockDatabase();
    const result = await new TheCragProvider(fetchFn).sync(makeRun(database.db));
    const exposed = inspect(
      { errors: result.errors, telemetry: mocks.captureException.mock.calls },
      {
        depth: null,
      },
    );
    expect(exposed).not.toContain("KEY123");
    expect(exposed).not.toContain("NOTE456");
    expect(exposed).not.toContain(body);
    expect(result.errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/invalid.*json.*try again/i) }),
    ]);
    expect(mocks.captureException).toHaveBeenCalled();
    for (const [error] of mocks.captureException.mock.calls) {
      expect(error).toMatchObject({ message: expect.stringMatching(/invalid.*json.*try again/i) });
      if (!(error instanceof Error)) throw new Error("Telemetry did not receive an Error");
      expect(error.cause).toBeUndefined();
    }
    expect(database.spies.execute).not.toHaveBeenCalled();
  });

  it("projects observed climbing facts while retaining the complete source ascent", async () => {
    const source = theCragAscent({ date: "2026-10-10T23:15:00-07:00", arbitrarySourceField: 42 });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response([source]));
    const database = createMockDatabase({
      executeResult: [{ id: "00000000-0000-0000-0000-000000000010" }],
    });
    const result = await new TheCragProvider(fetchFn).sync(makeRun(database.db));
    expect(result).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(writtenRecords(database)).toEqual([
      expect.objectContaining({
        external_id: "thecrag:1001",
        unattached_date: "2026-10-10",
        climb_type: "route",
        grade_system: "yds",
        grade: "5.10a",
        result_style: "Redpoint",
        climb_style: null,
        route_protection: ["sport"],
        attempt_count: null,
        board: null,
        wall_angle: null,
        route_name: "Sunset Arete",
        location_path: [
          { name: "United States", externalId: "3001", kind: null },
          { name: "Example Crag", externalId: "3002", kind: null },
          { name: "South Wall", externalId: "3003", kind: null },
        ],
        raw: { accountId: "123", ascent: source },
      }),
    ]);
    expect(mocks.loadTokens).toHaveBeenCalledWith(database.db, "thecrag", USER_ID);
  });

  it("projects repeated ancestor aliases once while retaining their raw source identities", async () => {
    const source = theCragAscent();
    if (source.route === null || typeof source.route !== "object") {
      throw new Error("The source fixture is missing its route");
    }
    source.route = {
      ...source.route,
      ancestors: {
        country: { id: "3001", name: "United States", depth: 1 },
        TLC: { id: "3002", name: "Example Crag", depth: 4 },
        parent: { id: "3002", name: "Example Crag", depth: 4 },
      },
    };
    const database = createMockDatabase({ executeResult: [{ id: "entry-1" }] });
    const result = await new TheCragProvider(
      vi.fn<typeof fetch>().mockResolvedValue(response([source])),
    ).sync(makeRun(database.db));
    expect(result.errors).toEqual([]);
    expect(writtenRecords(database)).toEqual([
      expect.objectContaining({
        location_path: [
          { name: "United States", externalId: "3001", kind: null },
          { name: "Example Crag", externalId: "3002", kind: null },
        ],
        raw: { accountId: "123", ascent: source },
      }),
    ]);
  });

  it.each([
    ["V4", "Boulder", "boulder", "v_scale", "V4"],
    ["5.10a", "Sport", "sport", "yds", "5.10a"],
    ["FR 6a", "Sport", "sport", "french", "6a"],
    ["FB 6A", "Boulder", "boulder", "font", "6A"],
    ["AU 19", "Trad", "trad", "ewbank", "19"],
    ["UIAA 7", "Trad", "trad", "uiaa", "7"],
    ["FR:6a", "Sport", "sport", "french", "6a"],
    ["FB:6A", "Boulder", "boulder", "font", "6A"],
    ["AU:19", "Trad", "trad", "ewbank", "19"],
    ["UIAA:7", "Trad", "trad", "uiaa", "7"],
    ["YDS:5.10a", "Sport", "sport", "yds", "5.10a"],
    ["BLDV:V3", "Boulder", "boulder", "v_scale", "V3"],
  ])(
    "maps evidenced grade %s without interpreting gradeAtom.type",
    async (sourceGrade, style, climbedGearStyle, gradeSystem, grade) => {
      const source = theCragAscent({
        climbedGearStyle,
        route: { id: "2001", name: "Climb", grade: sourceGrade, style, gradeAtom: { type: "99" } },
      });
      const database = createMockDatabase({ executeResult: [{ id: "entry-1" }] });
      const result = await new TheCragProvider(
        vi.fn<typeof fetch>().mockResolvedValue(response([source])),
      ).sync(makeRun(database.db));
      expect(result).toMatchObject({ recordsSynced: 1, errors: [] });
      expect(writtenRecords(database)).toEqual([
        expect.objectContaining({
          grade_system: gradeSystem,
          grade,
          raw: { accountId: "123", ascent: source },
        }),
      ]);
    },
  );

  it.each(["19", "6a", "6A", "", "5.99", "FR nonsense"])(
    "rejects unsupported or ambiguous grade %j before storing any ascent",
    async (grade) => {
      const database = createMockDatabase();
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
        response([
          theCragAscent(),
          theCragAscent({
            id: "1002",
            route: { id: "2002", name: "Climb", grade, style: "Sport" },
          }),
        ]),
      );
      const result = await new TheCragProvider(fetchFn).sync(makeRun(database.db));
      expect(result.recordsSynced).toBe(0);
      expect(result.errors).toEqual([
        expect.objectContaining({ message: expect.stringMatching(/grade/i) }),
      ]);
      expect(database.spies.execute).not.toHaveBeenCalled();
    },
  );

  it.each(["2026", "2026-10", "2026-02-30", "0000-01-01", "2026-10-10garbage"])(
    "rejects invalid or partial source date %s before writes",
    async (date) => {
      const database = createMockDatabase();
      const result = await new TheCragProvider(
        vi.fn<typeof fetch>().mockResolvedValue(response([theCragAscent({ date })])),
      ).sync(makeRun(database.db));
      expect(result.errors).toEqual([
        expect.objectContaining({ message: expect.stringMatching(/date/i) }),
      ]);
      expect(database.spies.execute).not.toHaveBeenCalled();
    },
  );

  it("keeps unfamiliar tick outcomes and missing metadata explicit", async () => {
    const database = createMockDatabase({ executeResult: [{ id: "entry-1" }] });
    const result = await new TheCragProvider(
      vi.fn<typeof fetch>().mockResolvedValue(
        response([
          theCragAscent({
            climbedGearStyle: null,
            tick: { label: "unfamiliar-result", name: "Unfamiliar result" },
            route: { id: "2001", name: null, grade: "V4", style: "Boulder", ancestors: null },
          }),
        ]),
      ),
    ).sync(makeRun(database.db));
    expect(result.errors).toEqual([]);
    expect(writtenRecords(database)).toEqual([
      expect.objectContaining({
        result_style: "Unfamiliar result",
        route_name: null,
        location_path: [],
        route_protection: null,
        attempt_count: null,
      }),
    ]);
  });

  it("fetches every page before one bulk write", async () => {
    const database = createMockDatabase({ executeResult: [{ id: "entry-1" }, { id: "entry-2" }] });
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([theCragAscent()], { numberAscents: 2, perPage: 1 }))
      .mockImplementationOnce(async () => {
        expect(database.spies.execute).not.toHaveBeenCalled();
        return response([theCragAscent({ id: "1002" })], {
          numberAscents: 2,
          perPage: 1,
          page: "2",
        });
      });
    const result = await new TheCragProvider(fetchFn).sync(makeRun(database.db));
    expect(result).toMatchObject({ recordsSynced: 2, errors: [] });
    expect(new URL(String(fetchFn.mock.calls[1]?.[0])).searchParams.get("page")).toBe("2");
    expect(database.spies.execute).toHaveBeenCalledTimes(1);
  });

  it("reports save failures without exposing private bound ascent data", async () => {
    const privateNotes = "secret-notes-do-not-report";
    const database = createMockDatabase();
    const postgresError = Object.assign(new Error("Check constraint failed"), { code: "23514" });
    const failure = new DrizzleQueryError(
      "INSERT INTO fitness.climbing_entry SELECT private parameters",
      [JSON.stringify([{ raw: { ascent: { markdown: privateNotes } } }])],
      postgresError,
    );
    database.spies.execute.mockRejectedValueOnce(failure);
    const result = await new TheCragProvider(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(response([theCragAscent({ markdown: privateNotes })])),
    ).sync(makeRun(database.db));
    const exposed = inspect(
      { errors: result.errors, telemetry: mocks.captureException.mock.calls },
      { depth: null },
    );
    expect(exposed).not.toContain(privateNotes);
    expect(exposed).not.toContain("private parameters");
    expect(result).toMatchObject({
      recordsSynced: 0,
      errors: [
        expect.objectContaining({ message: expect.stringMatching(/could not save.*try again/i) }),
      ],
    });
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/could not save.*try again/i) }),
      expect.objectContaining({ tags: expect.objectContaining({ postgresCode: "23514" }) }),
    );
    for (const [error] of mocks.captureException.mock.calls) {
      if (!(error instanceof Error)) throw new Error("Save failure was not reported as an error");
      expect(error.cause).toBeUndefined();
    }
  });

  it("preserves existing data when a later page fails", async () => {
    const database = createMockDatabase();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([theCragAscent()], { numberAscents: 2, perPage: 1 }))
      .mockResolvedValueOnce(new Response("upstream error", { status: 400 }));
    const result = await new TheCragProvider(fetchFn).sync(makeRun(database.db));
    expect(result).toMatchObject({
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: expect.stringContaining("400") })],
    });
    expect(database.spies.execute).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it.each([
    { numberAscents: 2, perPage: 1, page: "2" },
    { numberAscents: 2, perPage: 1 },
  ])("rejects incomplete or inconsistent pagination %j", async (pagination) => {
    const database = createMockDatabase();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([theCragAscent()], pagination))
      .mockResolvedValueOnce(response([], { numberAscents: 2, perPage: 1, page: "2" }));
    const result = await new TheCragProvider(fetchFn).sync(makeRun(database.db));
    expect(result.errors).toHaveLength(1);
    expect(database.spies.execute).not.toHaveBeenCalled();
  });

  it("rejects source account mismatches before writing", async () => {
    const database = createMockDatabase();
    const result = await new TheCragProvider(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(response([theCragAscent()], { account: { id: "456" } })),
    ).sync(makeRun(database.db));
    expect(result.errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/account.*reconnect/i) }),
    ]);
    expect(database.spies.execute).not.toHaveBeenCalled();
  });

  it("uses the current account update watermark with a one-second overlap for scheduled syncs", async () => {
    const database = createMockDatabase();
    database.spies.execute
      .mockResolvedValueOnce([{ epoch: 1791676800 }])
      .mockResolvedValueOnce([{ id: "entry-1" }]);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response([theCragAscent()]));
    const result = await new TheCragProvider(fetchFn).sync(
      makeRun(database.db, { full: false, origin: "scheduled" }),
    );
    expect(result.errors).toEqual([]);
    expect(new URL(String(fetchFn.mock.calls[0]?.[0])).searchParams.get("since")).toBe(
      "1791676799",
    );
    const query = database.spies.execute.mock.calls[0]?.[0];
    if (!(query instanceof SQL)) throw new Error("No cursor lookup was issued");
    expect(new PgDialect().sqlToQuery(query).params).toEqual(
      expect.arrayContaining([USER_ID, "thecrag", "123"]),
    );
  });

  it("starts with full history when the current account has no saved epoch", async () => {
    const database = createMockDatabase({ executeResult: [{ epoch: null }] });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response());
    const result = await new TheCragProvider(fetchFn).sync(
      makeRun(database.db, { full: false, origin: "scheduled" }),
    );
    expect(result.errors).toEqual([]);
    expect(new URL(String(fetchFn.mock.calls[0]?.[0])).searchParams.has("since")).toBe(false);
    expect(database.spies.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    { full: true, origin: "scheduled" as const },
    { full: false, origin: "manual" as const },
  ])("fetches full history without loading an incremental cursor for %j", async (options) => {
    const database = createMockDatabase();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response());
    const result = await new TheCragProvider(fetchFn).sync(makeRun(database.db, options));
    expect(result.errors).toEqual([]);
    expect(new URL(String(fetchFn.mock.calls[0]?.[0])).searchParams.has("since")).toBe(false);
    expect(database.spies.execute).not.toHaveBeenCalled();
  });

  it("explains missing account identity before requesting data", async () => {
    mocks.loadTokens.mockResolvedValue({ ...tokens(), providerAccountId: undefined });
    const database = createMockDatabase();
    const fetchFn = vi.fn<typeof fetch>();
    const result = await new TheCragProvider(fetchFn).sync(makeRun(database.db));
    expect(result.errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/reconnect/i) }),
    ]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
