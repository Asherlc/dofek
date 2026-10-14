import { inspect } from "node:util";
import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
} from "@dofek/provider-http/rate-limit";
import { DrizzleQueryError, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClimbingLogSyncInput } from "../db/climbing-log-sync.ts";
import type { SyncDatabase } from "../db/index.ts";
import { authFailureReasonFromError, ProviderTokenRejectedError } from "./auth-errors.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createMockDatabase, theCragAscent, theCragPage } from "./test-helpers.ts";
import { TheCragProvider } from "./thecrag.ts";

const USER_ID = "00000000-0000-0000-0000-000000000001";
const ACCOUNT_ID = "123";
const mocks = vi.hoisted(() => ({
  persist: vi.fn(async (_db: SyncDatabase, input: ClimbingLogSyncInput) => ({
    logEntryIds: input.entries.map((entry) => entry.externalId),
    recordsSynced: input.entries.length,
  })),
  ensureProvider: vi.fn().mockResolvedValue(undefined),
  loadTokens: vi.fn(),
  captureException: vi.fn(),
  withSyncLog: vi.fn(
    async (_database, _providerId, _dataType, callback) => (await callback()).result,
  ),
}));

vi.mock("../db/climbing-log-sync.ts", () => ({ persistClimbingLogEntries: mocks.persist }));
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

function writtenRecords() {
  const input = mocks.persist.mock.calls.at(-1)?.[1];
  if (!input) throw new Error("No source batch was written");
  return input.entries;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
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
    await expect(exchange("personal-key")).rejects.toMatchObject({
      message: expect.stringMatching(/invalid logbook response/i),
      cause: expect.objectContaining({ name: "ZodError" }),
    });
  });

  it.each([{ page: 0 }, { page: "0" }, { perPage: 0 }, { perPage: "0" }])(
    "rejects unusable logbook page metadata %j during connection",
    async (metadata) => {
      const exchange = new TheCragProvider(
        vi.fn<typeof fetch>().mockResolvedValue(response([], metadata)),
      ).authSetup().manualToken?.exchangeToken;
      if (!exchange) throw new Error("Personal key connection is unavailable");
      await expect(exchange("personal-key")).rejects.toThrow(/invalid logbook response/i);
    },
  );

  it("does not send an empty personal key", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const exchange = new TheCragProvider(fetchFn).authSetup().manualToken?.exchangeToken;
    if (!exchange) throw new Error("Personal key connection is unavailable");
    await expect(exchange("  ")).rejects.toBeInstanceOf(ProviderTokenRejectedError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ["carriage return", "\r"],
    ["line feed", "\n"],
    ["CRLF", "\r\n"],
    ["null", "\u0000"],
    ["control character", "\u0001"],
    ["DEL", "\u007f"],
    ["non-Latin-1 character", "\u0100"],
  ])(
    "rejects keys containing %s without exposing their value or contacting the service",
    async (_label, character) => {
      const secret = `private-key-start${character}private-key-end`;
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_input, options) => {
        new Headers(options?.headers);
        return response();
      });
      const exchange = new TheCragProvider(fetchFn).authSetup().manualToken?.exchangeToken;
      if (!exchange) throw new Error("Personal key connection is unavailable");
      const error = await exchange(secret).catch((rejection: unknown) => rejection);
      expect(error).toBeInstanceOf(ProviderTokenRejectedError);
      expect(error).toMatchObject({
        message: expect.stringMatching(/paste.*API key.*invalid.*character/i),
      });
      if (!(error instanceof Error)) throw new Error("Invalid key did not produce an error");
      expect(error.cause).toBeUndefined();
      const exposed = inspect(
        { error, telemetry: mocks.captureException.mock.calls },
        { depth: null },
      );
      expect(exposed).not.toContain("private-key-start");
      expect(exposed).not.toContain("private-key-end");
      expect(fetchFn).not.toHaveBeenCalled();
      expect(mocks.captureException).not.toHaveBeenCalled();
    },
  );

  it.each(["valid-key_+/=.:", "valid\tkey", "valid-é-key"])(
    "verifies header-safe key %j through the service without guessing its format",
    async (key) => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response());
      const exchange = new TheCragProvider(fetchFn).authSetup().manualToken?.exchangeToken;
      if (!exchange) throw new Error("Personal key connection is unavailable");
      await expect(exchange(key)).resolves.toMatchObject({
        accessToken: key,
        providerAccountId: "123",
      });
      expect(fetchFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ "X-CData-Key": `key=${key}` }),
        }),
      );
    },
  );

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
  it.each([
    ["attempt", [{ scope: "climb", outcome: "failed" }]],
    ["dog", [{ scope: "climb", outcome: "completed", fellOrHung: true }]],
    ["tick", [{ scope: "climb", outcome: "completed" }]],
  ])("maps explicit source outcome %s independently of fall or hang", async (label, attempts) => {
    const database = createMockDatabase();
    const result = await new TheCragProvider(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(response([theCragAscent({ tick: { label, name: label } })])),
    ).sync(makeRun(database.db));
    expect(result).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(writtenRecords()[0]).toMatchObject({ notes: "Personal ascent notes", attempts });
  });
  it("maps an aid Onsight without inferring falling or hanging", async () => {
    const database = createMockDatabase();
    await new TheCragProvider(
      vi.fn<typeof fetch>().mockResolvedValue(
        response([
          theCragAscent({
            climbedGearStyle: "aid",
            tick: { label: "onsight", name: "Aid Onsight" },
          }),
        ]),
      ),
    ).sync(makeRun(database.db));
    expect(writtenRecords()[0]).toMatchObject({
      attempts: [{ scope: "climb", usedAid: true, qualifier: "aid-onsight" }],
    });
  });
  it.each([
    ["lead solo", "lead", false],
    ["top rope solo", "top_rope", false],
    ["aid solo", null, true],
  ] as const)("maps independent method and aid use for %s", async (label, ropeMethod, aid) => {
    const database = createMockDatabase();
    await new TheCragProvider(async () =>
      response([theCragAscent({ climbedGearStyle: aid ? "aid" : "sport", tick: { label } })]),
    ).sync(makeRun(database.db));
    expect(writtenRecords()[0]?.attempts).toEqual([
      expect.objectContaining({
        scope: "climb",
        solo: true,
        ropeMethod,
        ...(aid ? { usedAid: true } : {}),
      }),
    ]);
  });
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
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { provider: "thecrag", phase: "logbook_response" },
    });
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
    expect(writtenRecords()).toEqual([
      expect.objectContaining({
        externalId: "thecrag:1001",
        climbedOn: "2026-10-10",
        attempts: [
          expect.objectContaining({
            scope: "climb",
            qualifier: "free-send",
            protectionUsed: ["sport"],
          }),
        ],
        raw: { accountId: "123", ascent: source },
        climb: expect.objectContaining({
          kind: "route",
          publishedGrades: [{ system: "yds", value: "5.10a" }],
          name: "Sunset Arete",
          areas: [
            { name: "United States", externalId: "3001" },
            { name: "Example Crag", externalId: "3002" },
            { name: "South Wall", externalId: "3003" },
          ],
        }),
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
    expect(writtenRecords()).toEqual([
      expect.objectContaining({
        raw: { accountId: "123", ascent: source },
        climb: expect.objectContaining({
          areas: [
            { name: "United States", externalId: "3001" },
            { name: "Example Crag", externalId: "3002" },
          ],
        }),
      }),
    ]);
  });

  it.each([
    ["V4", "Boulder", "boulder", "v_scale", "V4"],
    [" V10 ", "Boulder", "boulder", "v_scale", "V10"],
    ["VB+", "Boulder", "boulder", "v_scale", "VB+"],
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
    ["FR:  6a", "Sport", "sport", "french", "6a"],
    ["FR \n6a", "Sport", "sport", "french", "6a"],
    ["AID A2", "Aid", "aid", "aid", "A2"],
    ["AIDC C2+", "Aid", "aid", "aid", "C2+"],
    ["WICE WI4+", "Ice", "ice", "water_ice", "WI4+"],
    ["AICE AI3", "Ice", "ice", "alpine_ice", "AI3"],
    ["MIXED M6+", "Mixed", "mixed", "mixed", "M6+"],
    ["IFAS AD+", "Alpine", "alpine", "ifas", "AD+"],
    ["NCCS VI", "Alpine", "alpine", "nccs", "VI"],
    ["UK E3", "Trad", "trad", "british_adjectival", "E3"],
    ["UKT 5c", "Trad", "trad", "british_technical", "5c"],
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
      expect(writtenRecords()).toEqual([
        expect.objectContaining({
          raw: { accountId: "123", ascent: source },
          climb: expect.objectContaining({
            publishedGrades: [{ value: grade, system: gradeSystem }],
          }),
        }),
      ]);
    },
  );
  it("keeps advertised sport protection separate from a Greenpoint's trad protection", async () => {
    const database = createMockDatabase();
    await new TheCragProvider(async () =>
      response([
        theCragAscent({
          climbedGearStyle: "trad",
          tick: { label: "greenpoint" },
          route: { id: "2001", grade: "YDS 5.10a AIDC C2", style: "Sport" },
        }),
      ]),
    ).sync(makeRun(database.db));
    expect(writtenRecords()[0]).toMatchObject({
      climb: {
        routeProtection: ["sport"],
        publishedGrades: [
          { value: "5.10a", system: "yds" },
          { value: "C2", system: "aid" },
        ],
      },
      attempts: [{ scope: "climb", protectionUsed: ["trad"], qualifier: "free-send" }],
    });
  });
  it.each([
    ["repeat", { hadCompletedBefore: true }],
    ["ground-up redpoint", { priorFailedAttemptsGroundUp: true }],
    ["pinkpoint", { usedPreplacedProtection: true }],
    ["french free", { usedAid: true }],
    ["dab", { qualifier: "dab" }],
    ["fell/hung", { qualifier: "fell-hung" }],
  ])("maps independent source facts for %s", async (label, facts) => {
    const database = createMockDatabase();
    await new TheCragProvider(async () => response([theCragAscent({ tick: { label } })])).sync(
      makeRun(database.db),
    );
    expect(writtenRecords()[0]?.attempts).toEqual([
      expect.objectContaining({ scope: "climb", ...facts }),
    ]);
  });

  it.each([
    "19",
    "6a",
    "6A",
    "",
    "5.99",
    "FR nonsense",
    "prefix FR:6a",
    "FRextra:6a",
    "FR:6a\ntrailing",
    "NCCST T6",
    "AUAID M5",
  ])("retains grade text with an unknown system %j", async (grade) => {
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
    expect(result).toMatchObject({ recordsSynced: 2, errors: [] });
    const definition = writtenRecords()[1]?.climb;
    if (grade !== "")
      expect(definition).toMatchObject({ publishedGrades: [{ value: grade, system: null }] });
    expect(writtenRecords()[1]?.raw).toMatchObject({ ascent: { route: { grade } } });
  });

  it.each([
    ["boulder", "Sport", "V4"],
    ["sport", "Boulder", "5.10a"],
  ])("rejects contradictory or unsupported discipline %s/%s", async (gear, style, grade) => {
    const database = createMockDatabase();
    const result = await new TheCragProvider(
      vi.fn<typeof fetch>().mockResolvedValue(
        response([
          theCragAscent({
            climbedGearStyle: gear,
            route: { id: "2001", grade, style },
          }),
        ]),
      ),
    ).sync(makeRun(database.db));
    expect(result.errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/climbing discipline/i) }),
    ]);
    expect(database.spies.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["V4", "Sport", "sport"],
    ["5.10a", "Boulder", "boulder"],
  ])(
    "rejects grade %s when it conflicts with the recorded discipline",
    async (grade, style, climbedGearStyle) => {
      const database = createMockDatabase();
      const result = await new TheCragProvider(
        vi.fn<typeof fetch>().mockResolvedValue(
          response([
            theCragAscent({
              climbedGearStyle,
              route: { id: "2001", grade, style },
            }),
          ]),
        ),
      ).sync(makeRun(database.db));
      expect(result.errors).toEqual([
        expect.objectContaining({
          message: expect.stringMatching(/unsupported or ambiguous grade/i),
        }),
      ]);
      expect(database.spies.execute).not.toHaveBeenCalled();
    },
  );

  it("retains aid records with an unknown grade system", async () => {
    const database = createMockDatabase();
    const result = await new TheCragProvider(
      vi.fn<typeof fetch>().mockResolvedValue(
        response([
          theCragAscent({
            climbedGearStyle: "aid",
            markdown: "private unsupported-ascent notes",
            route: { id: "2001", grade: "A1", style: "Aid" },
          }),
        ]),
      ),
    ).sync(makeRun(database.db));
    expect(result).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(writtenRecords()[0]).toMatchObject({
      discipline: "rock_climbing",
      attempts: [{ scope: "climb", usedAid: true }],
      climb: { kind: "route", publishedGrades: [{ value: "A1", system: null }] },
    });
    expect(
      inspect(
        { errors: result.errors, telemetry: mocks.captureException.mock.calls },
        { depth: null },
      ),
    ).not.toContain("private unsupported-ascent notes");
    expect(database.spies.execute).not.toHaveBeenCalled();
  });

  it("uses the recorded route discipline when gear style is absent", async () => {
    const database = createMockDatabase({ executeResult: [{ id: "entry-1" }] });
    const result = await new TheCragProvider(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(response([theCragAscent({ climbedGearStyle: null })])),
    ).sync(makeRun(database.db));
    expect(result.errors).toEqual([]);
    expect(writtenRecords()).toEqual([
      expect.objectContaining({
        attempts: [expect.objectContaining({ protectionUsed: null })],
        climb: expect.objectContaining({ kind: "route" }),
      }),
    ]);
  });

  it("rejects malformed ascent records with diagnostics before writing", async () => {
    const database = createMockDatabase();
    const result = await new TheCragProvider(
      vi.fn<typeof fetch>().mockResolvedValue(response([theCragAscent({ id: null })])),
    ).sync(makeRun(database.db));
    expect(result.errors).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/unsupported ascent response.*contact support/i),
        cause: expect.objectContaining({ cause: expect.objectContaining({ name: "ZodError" }) }),
      }),
    ]);
    expect(database.spies.execute).not.toHaveBeenCalled();
  });

  it("orders supplied ancestors by depth and preserves distinct locations without IDs", async () => {
    const source = theCragAscent({
      route: {
        id: "2001",
        grade: "5.10a",
        style: "Sport",
        ancestors: {
          parent: { id: null, name: "Area", depth: 5 },
          missingAlias: null,
          TLC: { id: null, name: "Area", depth: 4 },
          country: { id: "3001", name: "United States", depth: 1 },
        },
      },
    });
    const database = createMockDatabase({ executeResult: [{ id: "entry-1" }] });
    const result = await new TheCragProvider(
      vi.fn<typeof fetch>().mockResolvedValue(response([source])),
    ).sync(makeRun(database.db));
    expect(result.errors).toEqual([]);
    expect(writtenRecords()).toEqual([
      expect.objectContaining({
        raw: { accountId: "123", ascent: source },
        climb: expect.objectContaining({
          areas: [
            { name: "United States", externalId: "3001" },
            { name: "Area", externalId: null },
            { name: "Area", externalId: null },
          ],
        }),
      }),
    ]);
  });

  it.each([
    [null, undefined],
    [undefined, undefined],
    [{ name: "  ", label: " On sight " }, "free-onsight"],
  ])("retains nullable outcome metadata and trims source text (%j)", async (tick, qualifier) => {
    const database = createMockDatabase({ executeResult: [{ id: "entry-1" }] });
    const result = await new TheCragProvider(
      vi.fn<typeof fetch>().mockResolvedValue(
        response([
          theCragAscent({
            tick,
            climbedGearStyle: "trad",
            route: { id: "2001", name: " Route name ", grade: "5.10a", style: "Trad" },
          }),
        ]),
      ),
    ).sync(makeRun(database.db));
    expect(result.errors).toEqual([]);
    expect(writtenRecords()).toEqual([
      expect.objectContaining({
        attempts: [expect.objectContaining({ protectionUsed: ["trad"] })],
        climb: expect.objectContaining({ name: "Route name", routeProtection: ["trad"] }),
      }),
    ]);
    expect(writtenRecords()[0]?.attempts[0]?.qualifier).toBe(qualifier);
  });

  it("preserves the source day in a complete local ISO timestamp", async () => {
    const database = createMockDatabase({ executeResult: [{ id: "entry-1" }] });
    const result = await new TheCragProvider(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(response([theCragAscent({ date: "2026-10-10T23:15:00" })])),
    ).sync(makeRun(database.db));
    expect(result.errors).toEqual([]);
    expect(writtenRecords()).toEqual([expect.objectContaining({ climbedOn: "2026-10-10" })]);
  });

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
    expect(writtenRecords()).toEqual([
      expect.objectContaining({
        attempts: [expect.objectContaining({ protectionUsed: null })],
        climb: expect.objectContaining({
          kind: "boulder",
          publishedGrades: [{ value: "V4", system: "v_scale" }],
        }),
        raw: expect.objectContaining({
          ascent: expect.objectContaining({
            tick: { label: "unfamiliar-result", name: "Unfamiliar result" },
          }),
        }),
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
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });

  it("reports save failures without exposing private bound ascent data", async () => {
    const privateNotes = "secret-notes-do-not-report";
    const database = createMockDatabase();
    const postgresError = Object.assign(new Error("Check constraint failed"), { code: "23514" });
    const failure = new DrizzleQueryError(
      "INSERT INTO fitness.climbing_log_entry SELECT private parameters",
      [JSON.stringify([{ raw: { ascent: { markdown: privateNotes } } }])],
      postgresError,
    );
    mocks.persist.mockRejectedValueOnce(failure);
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

  it.each(["23514 private-note", "private-note23514"])(
    "omits invalid PostgreSQL code %j from telemetry while reporting the save failure",
    async (code) => {
      const database = createMockDatabase();
      const driverError = Object.assign(new Error("private driver details"), { code });
      mocks.persist.mockRejectedValueOnce(
        new DrizzleQueryError("INSERT private bound query", ["private ascent notes"], driverError),
      );
      const result = await new TheCragProvider(
        vi.fn<typeof fetch>().mockResolvedValue(response([theCragAscent()])),
      ).sync(makeRun(database.db));
      expect(result.errors).toEqual([
        expect.objectContaining({ message: expect.stringMatching(/could not save.*try again/i) }),
      ]);
      expect(mocks.captureException).toHaveBeenCalled();
      const exposed = inspect(
        { errors: result.errors, telemetry: mocks.captureException.mock.calls },
        { depth: null },
      );
      expect(exposed).not.toContain(code);
      expect(exposed).not.toContain("private driver details");
      expect(exposed).not.toContain("private ascent notes");
      expect(exposed).not.toContain("private bound query");
      for (const [error, metadata] of mocks.captureException.mock.calls) {
        expect(error.cause).toBeUndefined();
        expect(metadata.tags.postgresCode).toBeUndefined();
      }
    },
  );

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

  it.each([
    { numberAscents: 2, perPage: 2, page: "2" },
    { numberAscents: 2, perPage: 1, page: "2" },
  ])("rejects changing pagination metadata %j without saving earlier pages", async (secondPage) => {
    const firstTotal = secondPage.perPage === 1 ? 3 : 2;
    const database = createMockDatabase();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([theCragAscent()], { numberAscents: firstTotal, perPage: 1 }))
      .mockResolvedValueOnce(response([theCragAscent({ id: "1002" })], secondPage));
    const result = await new TheCragProvider(fetchFn).sync(makeRun(database.db));
    expect(result.errors).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/inconsistent logbook pagination/i),
      }),
    ]);
    expect(database.spies.execute).not.toHaveBeenCalled();
  });

  it.each([
    { ascents: [theCragAscent()], metadata: { page: 2, perPage: 1, numberAscents: 1 } },
    {
      ascents: [theCragAscent(), theCragAscent({ id: "1002" })],
      metadata: { page: 1, perPage: 1, numberAscents: 2 },
    },
  ])(
    "rejects a wrong page or an oversized page before writing (%j)",
    async ({ ascents, metadata }) => {
      const database = createMockDatabase();
      const result = await new TheCragProvider(
        vi.fn<typeof fetch>().mockResolvedValue(response(ascents, metadata)),
      ).sync(makeRun(database.db));
      expect(result.errors).toEqual([
        expect.objectContaining({
          message: expect.stringMatching(/inconsistent logbook pagination/i),
        }),
      ]);
      expect(database.spies.execute).not.toHaveBeenCalled();
    },
  );

  it("rejects an incomplete continuation page before saving any records", async () => {
    const database = createMockDatabase();
    const result = await new TheCragProvider(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(response([theCragAscent()], { perPage: 2, numberAscents: 3 })),
    ).sync(makeRun(database.db));
    expect(result.errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/incomplete logbook page/i) }),
    ]);
    expect(database.spies.execute).not.toHaveBeenCalled();
  });

  it("rejects duplicate ascent identities before the batch is written", async () => {
    const database = createMockDatabase();
    const result = await new TheCragProvider(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response([theCragAscent(), theCragAscent({ markdown: "Updated notes" })]),
        ),
    ).sync(makeRun(database.db));
    expect(result.errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/duplicate ascent identities/i) }),
    ]);
    expect(database.spies.execute).not.toHaveBeenCalled();
  });

  it("aborts a logbook that exceeds the page limit without saving a partial history", async () => {
    const database = createMockDatabase();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return response([theCragAscent({ id: String(page) })], {
        page,
        perPage: 1,
        numberAscents: 101,
      });
    });
    const result = await new TheCragProvider(fetchFn).sync(makeRun(database.db));
    expect(result.errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/pagination could not complete/i) }),
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(100);
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

  it("explains missing personal-key credentials before requesting data", async () => {
    mocks.loadTokens.mockResolvedValue(null);
    const database = createMockDatabase();
    const fetchFn = vi.fn<typeof fetch>();
    const result = await new TheCragProvider(fetchFn).sync(makeRun(database.db));
    expect(result.errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/API key.*reconnect/i) }),
    ]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(database.spies.execute).not.toHaveBeenCalled();
  });

  it("requires user attribution before loading credentials or contacting the provider", async () => {
    const database = createMockDatabase();
    const fetchFn = vi.fn<typeof fetch>();
    const result = await new TheCragProvider(fetchFn).sync(
      new SyncRun({
        db: database.db,
        window: SyncWindow.full(new Date("2026-10-11T23:59:59.999Z")),
      }),
    );
    expect(result.errors).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/requires a user context/i) }),
    ]);
    expect(mocks.ensureProvider).not.toHaveBeenCalled();
    expect(mocks.loadTokens).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails visibly when the saved update-position query returns no result", async () => {
    const database = createMockDatabase();
    const fetchFn = vi.fn<typeof fetch>();
    const result = await new TheCragProvider(fetchFn).sync(
      makeRun(database.db, { full: false, origin: "scheduled" }),
    );
    expect(result.errors).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/could not read its saved update position/i),
      }),
    ]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("preserves response-body transport errors for retry handling and reports their provider context", async () => {
    const database = createMockDatabase();
    const failure = new ProviderRequestTimeoutError({ providerId: "thecrag", timeoutMs: 120_000 });
    const body = response();
    vi.spyOn(body, "json").mockRejectedValue(failure);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(body);
    await expect(new TheCragProvider(fetchFn).sync(makeRun(database.db))).rejects.toBe(failure);
    expect(mocks.captureException).toHaveBeenCalledWith(failure, {
      tags: { provider: "thecrag", phase: "climbing_activity" },
    });
    expect(database.spies.execute).not.toHaveBeenCalled();
  });

  it.each([200, 400])("reports elapsed time for sync response %s", async (status) => {
    const database = createMockDatabase();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => {
      now.mockReturnValue(1_042);
      return status === 200 ? response() : new Response(null, { status });
    });
    const result = await new TheCragProvider(fetchFn).sync(makeRun(database.db));
    expect(result.duration).toBe(42);
    expect(result.errors).toHaveLength(status === 200 ? 0 : 1);
  });
});
