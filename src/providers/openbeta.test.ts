import {
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { climbingEntry } from "../db/schema/activity.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

const USER_ID = "00000000-0000-0000-0000-000000000001";
const OPENBETA_USER_UUID = "00000000-0000-0000-0000-000000000002";

const mocks = vi.hoisted(() => ({
  ensureProvider: vi.fn().mockResolvedValue(undefined),
  loadTokens: vi.fn().mockResolvedValue({
    accessToken: "51e4a2f9-93ca-44db-9efb-9bc663da6cbe",
    refreshToken: null,
    expiresAt: new Date("2099-12-31T00:00:00.000Z"),
    scopes: "ticks",
  }),
  withSyncLog: vi.fn(async (_db, _providerId, _dataType, callback) => (await callback()).result),
  captureException: vi.fn(),
}));

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: mocks.ensureProvider,
  loadTokens: mocks.loadTokens,
}));
vi.mock("../db/sync-log.ts", () => ({ withSyncLog: mocks.withSyncLog }));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: mocks.captureException }));

import { OpenBetaProvider } from "./openbeta.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function graphqlResponse(data: unknown): Response {
  return jsonResponse({ data });
}

function grades(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function climb(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: "climb-uuid-1",
    name: "Sunset Arete",
    grades: grades(),
    type: { bouldering: false },
    parent: { area_name: "Smith Rock" },
    ...overrides,
  };
}

function tick(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: "tick-1",
    userId: OPENBETA_USER_UUID,
    name: "Sunset Arete",
    notes: "Great movement",
    climbId: "climb-1",
    style: "Lead",
    attemptType: "Redpoint",
    dateClimbed: 1786320000000,
    grade: "5.10a",
    source: "OB",
    user: { username: "climber", displayName: "Climber" },
    climb: climb({ type: { trad: true, sport: false, bouldering: false } }),
    ...overrides,
  };
}

function makeDb() {
  const conflictUpdates = vi.fn().mockResolvedValue(undefined);
  const climbingEntryValues = vi.fn().mockReturnValue({ onConflictDoUpdate: conflictUpdates });
  const insert = vi.fn().mockReturnValue({ values: climbingEntryValues });
  return {
    db: {
      insert,
      delete: vi.fn(),
      select: vi.fn(),
      execute: vi.fn(),
    },
    climbingEntryValues,
    conflictUpdates,
    insert,
  };
}

function makeRun(db: ReturnType<typeof makeDb>["db"], userId = USER_ID): SyncRun {
  return new SyncRun({
    db,
    window: SyncWindow.full(new Date("2026-08-11T00:00:00.000Z")),
    userId,
  });
}

function makeRunWithoutUser(db: ReturnType<typeof makeDb>["db"]): SyncRun {
  return new SyncRun({
    db,
    window: SyncWindow.full(new Date("2026-08-11T00:00:00.000Z")),
  });
}

function exchangeToken(provider: OpenBetaProvider, input: string): Promise<unknown> {
  const exchange = provider.authSetup().manualToken?.exchangeToken;
  if (!exchange) throw new Error("OpenBeta manual token auth is unavailable");
  return exchange(input);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.loadTokens.mockResolvedValue({
    accessToken: OPENBETA_USER_UUID,
    refreshToken: null,
    expiresAt: new Date("2099-12-31T00:00:00.000Z"),
    scopes: "ticks",
  });
  mocks.withSyncLog.mockImplementation(
    async (_db, _providerId, _dataType, callback) => (await callback()).result,
  );
});

describe("OpenBetaProvider", () => {
  it.each([
    [null, []],
    [
      climb({ pathTokens: ["Country", "Wall"], parent: null }),
      [
        { name: "Country", externalId: null, kind: null },
        { name: "Wall", externalId: null, kind: null },
      ],
    ],
    [
      climb({
        pathTokens: ["Country", "Wall"],
        ancestors: ["country-id", "wall-id"],
        parent: null,
      }),
      [
        { name: "Country", externalId: "country-id", kind: null },
        { name: "Wall", externalId: "wall-id", kind: null },
      ],
    ],
    [
      climb({ pathTokens: [], parent: { uuid: "wall-id", area_name: "Wall" } }),
      [{ name: "Wall", externalId: "wall-id", kind: null }],
    ],
    [
      climb({ pathTokens: [], ancestors: [], parent: { uuid: "wall-id", area_name: "Wall" } }),
      [{ name: "Wall", externalId: "wall-id", kind: null }],
    ],
  ])(
    "preserves partial location context %j without inferring a method",
    async (sourceClimb, path) => {
      const { db, climbingEntryValues } = makeDb();
      const result = await new OpenBetaProvider(async () =>
        graphqlResponse({ userTicks: [tick({ climb: sourceClimb, style: null })] }),
      ).sync(makeRun(db));
      expect(result).toMatchObject({ recordsSynced: 1, errors: [] });
      expect(climbingEntryValues).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ locationPath: path, climbStyle: null, attemptCount: null }),
      );
    },
  );

  it("normalizes surrounding whitespace in supplied names and identities", async () => {
    const { db, climbingEntryValues } = makeDb();
    const result = await new OpenBetaProvider(async () =>
      graphqlResponse({
        userTicks: [
          tick({
            attemptType: " Frenchfree ",
            climb: climb({
              pathTokens: [" Country ", " Wall "],
              ancestors: [" country-id ", " wall-id "],
              parent: { uuid: " wall-id ", area_name: " Wall " },
            }),
          }),
        ],
      }),
    ).sync(makeRun(db));
    expect(result).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(climbingEntryValues).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        locationPath: [
          { name: "Country", externalId: "country-id", kind: null },
          { name: "Wall", externalId: "wall-id", kind: null },
        ],
        resultStyle: "Frenchfree",
      }),
    );
  });

  it.each([
    { attemptType: " " },
    { climb: climb({ pathTokens: [" "] }) },
    { climb: climb({ ancestors: [" "] }) },
    { climb: climb({ parent: { uuid: " ", area_name: "Wall" } }) },
  ])("rejects blank supplied context before writes %j", async (overrides) => {
    const { db, climbingEntryValues } = makeDb();
    const result = await new OpenBetaProvider(async () =>
      graphqlResponse({ userTicks: [tick(overrides)] }),
    ).sync(makeRun(db));
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(climbingEntryValues).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("retains an unfamiliar supplied result with a parent-only path", async () => {
    const { db, climbingEntryValues } = makeDb();
    const result = await new OpenBetaProvider(async () =>
      graphqlResponse({ userTicks: [tick({ attemptType: "Recorded qualifier" })] }),
    ).sync(makeRun(db));
    expect(result.errors).toEqual([]);
    expect(climbingEntryValues).toHaveBeenCalledWith(
      expect.objectContaining({
        resultStyle: "Recorded qualifier",
        attemptCount: null,
        locationPath: [{ name: "Smith Rock", externalId: null, kind: null }],
      }),
    );
  });
  it("retains the full aligned path and independent top-rope result", async () => {
    const names = ["Country", "State", "Region", "Park", "Crag", "Wall"];
    const ids = names.map((_, index) => `area-${index}`);
    const { db, climbingEntryValues } = makeDb();
    const fetchFn = vi.fn().mockResolvedValue(
      graphqlResponse({
        userTicks: [
          tick({
            style: "TR",
            attemptType: "Frenchfree",
            climb: climb({
              pathTokens: names,
              ancestors: ids,
              parent: { uuid: "area-5", area_name: "Wall" },
            }),
          }),
        ],
      }),
    );
    const result = await new OpenBetaProvider(fetchFn).sync(makeRun(db));
    expect(result.errors).toEqual([]);
    expect(climbingEntryValues).toHaveBeenCalledWith(
      expect.objectContaining({
        locationPath: names.map((name, index) => ({ name, externalId: ids[index], kind: null })),
        climbStyle: "top-rope",
        resultStyle: "Frenchfree",
        attemptCount: null,
        board: null,
        wallAngle: null,
      }),
    );
    const request = z
      .object({ query: z.string() })
      .parse(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)));
    expect(request.query).toContain("pathTokens");
    expect(request.query).toContain("ancestors");
  });

  it.each([
    { pathTokens: ["Crag", "Wall"], ancestors: ["area-1"] },
    {
      pathTokens: ["Wall"],
      ancestors: ["area-1"],
      parent: { uuid: "area-other", area_name: "Wall" },
    },
  ])("rejects mismatched paths before writing or reconciling %j", async (path) => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValue(1250);
    const { db, climbingEntryValues } = makeDb();
    const result = await new OpenBetaProvider(async () =>
      graphqlResponse({ userTicks: [tick({ climb: climb(path) })] }),
    ).sync(makeRun(db));
    expect(result.errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining("location path") }),
    ]);
    expect(climbingEntryValues).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
    expect(result.duration).toBe(250);
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { provider: "openbeta", phase: "tick_context" },
    });
  });
  it("resolves a public profile URL to the stable OpenBeta user UUID", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      graphqlResponse({
        userPage: {
          profile: {
            userUuid: OPENBETA_USER_UUID,
            username: "climber",
            displayName: "Climber",
          },
        },
      }),
    );
    const provider = new OpenBetaProvider(fetchFn);
    const setup = provider.authSetup();

    const tokenSet = await setup.manualToken?.exchangeToken("https://openbeta.io/u/climber/ticks");

    expect(tokenSet).toMatchObject({
      accessToken: OPENBETA_USER_UUID,
      refreshToken: null,
      scopes: "ticks",
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    const request = z
      .object({ variables: z.object({ username: z.string() }) })
      .parse(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)));
    expect(request.variables).toEqual({ username: "climber" });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.openbeta.io",
      expect.objectContaining({
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
      }),
    );
  });

  it.each([
    ["climber", "climber"],
    ["openbeta.io/u/climber", "climber"],
    ["http://www.openbeta.io/u/climber/ticks", "climber"],
  ])("accepts %s as the public profile identifier", async (input, expectedUsername) => {
    const fetchFn = vi.fn().mockResolvedValue(
      graphqlResponse({
        userPage: {
          profile: {
            userUuid: OPENBETA_USER_UUID,
            username: expectedUsername,
            displayName: null,
          },
        },
      }),
    );
    const provider = new OpenBetaProvider(fetchFn);

    await exchangeToken(provider, input);

    const request = z
      .object({ variables: z.object({ username: z.string() }) })
      .parse(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)));
    expect(request.variables).toEqual({ username: expectedUsername });
  });

  it("rejects malformed profile identifiers before making a request", async () => {
    const fetchFn = vi.fn();
    const provider = new OpenBetaProvider(fetchFn);
    for (const input of [
      "",
      "bad username",
      "https://example.com/u/climber",
      "https://openbeta.io/profile/climber",
      "https://openbeta.io/u/climber/other",
      "https://[",
    ]) {
      await expect(exchangeToken(provider, input)).rejects.toThrow(
        "Paste a public OpenBeta profile URL",
      );
    }

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects a profile URL with an invalid percent-encoded username", async () => {
    const provider = new OpenBetaProvider(vi.fn());

    await expect(exchangeToken(provider, "https://openbeta.io/u/%E0%A4%A")).rejects.toMatchObject({
      message:
        "Paste a public OpenBeta profile URL or username, and make sure the profile is public.",
      authFailureReason: "authentication_failed",
      cause: expect.any(URIError),
    });
  });

  it.each([
    [() => new Response("", { status: 500 }), "OpenBeta API request failed (500)."],
    [
      () => jsonResponse({ data: null, errors: [{ message: "profile lookup denied" }] }),
      "OpenBeta API returned an error: profile lookup denied",
    ],
    [() => jsonResponse({ data: null }), "OpenBeta API returned no data."],
  ])("preserves profile lookup failure", async (makeResponse, causeMessage) => {
    const provider = new OpenBetaProvider(vi.fn().mockResolvedValue(makeResponse()));

    await expect(exchangeToken(provider, "climber")).rejects.toMatchObject({
      message: causeMessage,
    });
  });

  it("rejects a profile response that does not satisfy the profile schema", async () => {
    const provider = new OpenBetaProvider(
      vi
        .fn()
        .mockResolvedValue(
          graphqlResponse({ userPage: { profile: { username: "climber", displayName: null } } }),
        ),
    );

    await expect(exchangeToken(provider, "climber")).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("preserves network failures for server error reporting", async () => {
    const error = new TypeError("fetch failed");
    const provider = new OpenBetaProvider(vi.fn().mockRejectedValue(error));

    await expect(exchangeToken(provider, "asherlc")).rejects.toBe(error);
  });

  it("explains when a public profile cannot be found", async () => {
    const provider = new OpenBetaProvider(
      vi.fn().mockResolvedValue(graphqlResponse({ userPage: { profile: null } })),
    );

    await expect(exchangeToken(provider, "asherlc")).rejects.toMatchObject({
      message:
        "Paste a public OpenBeta profile URL or username, and make sure the profile is public.",
      authFailureReason: "authentication_failed",
    });
  });

  it("imports route and boulder ticks into standalone climbing entries", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      graphqlResponse({
        userTicks: [
          tick(),
          tick({
            _id: "tick-2",
            name: "Blue Problem",
            grade: "V4",
            attemptType: "Attempt",
            dateClimbed: 1786406400000,
            climb: {
              uuid: "climb-uuid-2",
              name: "Blue Problem",
              grades: {
                vscale: "V4",
                yds: null,
                ewbank: null,
                french: null,
                font: null,
                uiaa: null,
                brazilianCrux: null,
              },
              type: { trad: false, sport: false, bouldering: true },
              parent: { area_name: "Smith Rock Boulders" },
            },
          }),
        ],
      }),
    );
    const { db, climbingEntryValues, conflictUpdates } = makeDb();
    const provider = new OpenBetaProvider(fetchFn);

    const result = await provider.sync(makeRun(db));

    expect(result).toMatchObject({ provider: "openbeta", recordsSynced: 2, errors: [] });
    const values = climbingEntryValues.mock.calls.map(([value]) => value);
    expect(values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: USER_ID,
          providerId: "openbeta",
          activityId: null,
          unattachedDate: "2026-08-10",
          externalId: "openbeta:tick-1",
          climbType: "route",
          gradeSystem: "yds",
          grade: "5.10a",
          resultStyle: "Redpoint",
          attemptCount: null,
          routeName: "Sunset Arete",
          locationPath: [{ name: "Smith Rock", externalId: null, kind: null }],
          sourceName: "OpenBeta",
          raw: expect.objectContaining({ _id: "tick-1", source: "OB" }),
        }),
        expect.objectContaining({
          externalId: "openbeta:tick-2",
          unattachedDate: "2026-08-11",
          climbType: "boulder",
          gradeSystem: "v_scale",
          grade: "V4",
          resultStyle: "Attempt",
          attemptCount: null,
          locationPath: [{ name: "Smith Rock Boulders", externalId: null, kind: null }],
        }),
      ]),
    );
    expect(conflictUpdates).toHaveBeenCalledWith(
      expect.objectContaining({
        target: [climbingEntry.userId, climbingEntry.providerId, climbingEntry.externalId],
        set: expect.objectContaining({ providerAbsentAt: null }),
      }),
    );
    expect(db.execute).toHaveBeenCalledOnce();
    const reconciliationQuery = db.execute.mock.calls[0]?.[0];
    if (!(reconciliationQuery instanceof SQL)) throw new Error("Expected reconciliation SQL");
    expect(new PgDialect().sqlToQuery(reconciliationQuery).params).toContain("openbeta:tick-1");
  });

  it("maps supported grade systems and tick fallbacks", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      graphqlResponse({
        userTicks: [
          tick({
            _id: "font-grade",
            grade: null,
            attemptType: null,
            climb: climb({
              name: null,
              grades: grades({ yds: null, font: " 6A+ " }),
              type: { bouldering: true },
              parent: { area_name: " " },
            }),
          }),
          tick({
            _id: "french-grade",
            grade: null,
            climb: climb({ grades: grades({ yds: null, french: "6a" }) }),
          }),
          tick({
            _id: "uiaa-grade",
            grade: null,
            climb: climb({ grades: grades({ yds: null, french: null, uiaa: "VI" }) }),
          }),
          tick({
            _id: "ewbank-grade",
            grade: null,
            climb: climb({
              grades: grades({ yds: null, french: null, uiaa: null, ewbank: "18" }),
            }),
          }),
          tick({
            _id: "brazilian-grade",
            grade: null,
            climb: climb({
              grades: grades({
                yds: null,
                french: null,
                uiaa: null,
                ewbank: null,
                brazilianCrux: "6sup",
              }),
            }),
          }),
          tick({
            _id: "boulder-v-fallback",
            grade: "v7+",
            climb: climb({ grades: grades({ yds: null }), type: { bouldering: true } }),
          }),
          tick({
            _id: "boulder-font-fallback",
            grade: "6b",
            climb: climb({ grades: grades({ yds: null }), type: { bouldering: true } }),
          }),
          tick({
            _id: "route-yds-fallback",
            grade: "5.11a",
            climb: climb({ grades: grades({ yds: null }) }),
          }),
          tick({
            _id: "route-french-fallback",
            grade: "6c+",
            climb: climb({ grades: grades({ yds: null }) }),
          }),
          tick({
            _id: "missing-climb-details",
            grade: "5.10b",
            name: null,
            attemptType: null,
            climb: { uuid: null, name: null, grades: null, type: null, parent: null },
          }),
        ],
      }),
    );
    const { db, climbingEntryValues } = makeDb();
    const provider = new OpenBetaProvider(fetchFn);

    const result = await provider.sync(makeRun(db));

    expect(result).toMatchObject({ provider: "openbeta", recordsSynced: 10, errors: [] });
    expect(climbingEntryValues.mock.calls.map(([value]) => value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: "openbeta:font-grade",
          gradeSystem: "font",
          grade: "6A+",
          resultStyle: null,
          attemptCount: null,
          routeName: "Sunset Arete",
          locationPath: [],
        }),
        expect.objectContaining({
          externalId: "openbeta:french-grade",
          gradeSystem: "french",
          grade: "6a",
        }),
        expect.objectContaining({
          externalId: "openbeta:uiaa-grade",
          gradeSystem: "uiaa",
          grade: "VI",
        }),
        expect.objectContaining({
          externalId: "openbeta:ewbank-grade",
          gradeSystem: "ewbank",
          grade: "18",
        }),
        expect.objectContaining({
          externalId: "openbeta:brazilian-grade",
          gradeSystem: "brazilian_crux",
          grade: "6sup",
        }),
        expect.objectContaining({
          externalId: "openbeta:boulder-v-fallback",
          gradeSystem: "v_scale",
          grade: "v7+",
        }),
        expect.objectContaining({
          externalId: "openbeta:boulder-font-fallback",
          gradeSystem: "font",
          grade: "6b",
        }),
        expect.objectContaining({
          externalId: "openbeta:route-yds-fallback",
          gradeSystem: "yds",
          grade: "5.11a",
        }),
        expect.objectContaining({
          externalId: "openbeta:route-french-fallback",
          gradeSystem: "french",
          grade: "6c+",
        }),
        expect.objectContaining({
          externalId: "openbeta:missing-climb-details",
          gradeSystem: "yds",
          routeName: null,
          locationPath: [],
          resultStyle: null,
          attemptCount: null,
        }),
      ]),
    );
  });

  it.each([
    [null, null],
    [253402300800000, null],
    [-62167219200001, null],
    [-62167219200000, null],
    [-62135596800000, "0001-01-01"],
    [253402214400000, "9999-12-31"],
  ] as const)("parses numeric date boundary %s into %s", async (dateClimbed, expectedDate) => {
    const fetchFn = vi.fn().mockResolvedValue(
      graphqlResponse({
        userTicks: [tick({ _id: "missing-date", name: null, dateClimbed })],
      }),
    );
    const { db, climbingEntryValues } = makeDb();
    const result = await new OpenBetaProvider(fetchFn).sync(makeRun(db));
    if (expectedDate) {
      expect(result.errors).toEqual([]);
      expect(climbingEntryValues).toHaveBeenCalledWith(
        expect.objectContaining({
          unattachedDate: expectedDate,
          raw: expect.objectContaining({ dateClimbed }),
        }),
      );
    } else {
      expect(result.errors).toEqual([
        expect.objectContaining({
          externalId: "missing-date",
          message: `Skipped OpenBeta tick missing-date: invalid date ${dateClimbed ?? "(empty)"}.`,
        }),
      ]);
      expect(climbingEntryValues).not.toHaveBeenCalled();
    }
  });

  it("follows the OpenBeta offset pagination contract", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => tick({ _id: `tick-${index + 1}` }));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(graphqlResponse({ userTicks: firstPage }))
      .mockResolvedValueOnce(graphqlResponse({ userTicks: [tick({ _id: "tick-101" })] }));
    const { db, climbingEntryValues } = makeDb();
    const provider = new OpenBetaProvider(fetchFn);

    const result = await provider.sync(makeRun(db));

    expect(result).toMatchObject({ provider: "openbeta", recordsSynced: 101, errors: [] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const secondRequest = z
      .object({ variables: z.object({ offset: z.number(), limit: z.number() }) })
      .parse(JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body)));
    expect(secondRequest.variables).toEqual({ limit: 100, offset: 100 });
    expect(climbingEntryValues).toHaveBeenCalledTimes(101);
  });

  it.each([
    ["empty tick id", tick({ _id: "" })],
    ["invalid style", tick({ style: "Unknown" })],
    ["blank result label", tick({ attemptType: " " })],
    ["invalid source", tick({ source: "Unknown" })],
    ["invalid user payload", tick({ user: { username: 42, displayName: null } })],
    ["invalid grades payload", tick({ climb: climb({ grades: { yds: 5.1 } }) })],
    ["string date scalar", tick({ dateClimbed: "2026-08-10" })],
    ["invalid climb type payload", tick({ climb: climb({ type: { bouldering: "false" } }) })],
    ["invalid parent payload", tick({ climb: climb({ parent: { area_name: 42 } }) })],
  ])("rejects %s instead of importing malformed tick data", async (_label, malformedTick) => {
    const fetchFn = vi.fn().mockResolvedValue(graphqlResponse({ userTicks: [malformedTick] }));
    const { db, climbingEntryValues } = makeDb();
    const provider = new OpenBetaProvider(fetchFn);

    const result = await provider.sync(makeRun(db));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors[0]?.cause).toMatchObject({ name: "ZodError" });
    expect(climbingEntryValues).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ZodError" }),
      { tags: { provider: "openbeta", phase: "tick_export" } },
    );
  });

  it("does not reconcile a complete response when one tick has an invalid date", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      graphqlResponse({
        userTicks: [tick(), tick({ _id: "bad-date", dateClimbed: 8640000000000001 })],
      }),
    );
    const { db } = makeDb();
    const provider = new OpenBetaProvider(fetchFn);

    const result = await provider.sync(makeRun(db));

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.degradations).toEqual([
      expect.objectContaining({
        kind: "record_rejected",
        providerId: "openbeta",
        stepName: "climbing_activity",
        context: { invalidDateCount: 1, unsupportedGradeCount: 0 },
      }),
    ]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("does not reconcile a complete response when one tick has an unsupported grade", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      graphqlResponse({
        userTicks: [
          tick(),
          tick({
            _id: "unsupported-grade",
            grade: "unknown",
            climb: climb({ grades: grades({ yds: null }) }),
          }),
        ],
      }),
    );
    const { db } = makeDb();
    const provider = new OpenBetaProvider(fetchFn);

    const result = await provider.sync(makeRun(db));

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toEqual([
      expect.objectContaining({ context: { unsupportedGradeCount: 1 } }),
    ]);
    expect(result.degradations).toEqual([
      expect.objectContaining({
        kind: "record_rejected",
        providerId: "openbeta",
        stepName: "climbing_activity",
        context: { invalidDateCount: 0, unsupportedGradeCount: 1 },
      }),
    ]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("does not reconcile when ticks are malformed or have unsupported grades", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      graphqlResponse({
        userTicks: [
          tick({ dateClimbed: 8640000000000001 }),
          tick({
            _id: "tick-2",
            grade: null,
            climb: {
              uuid: "climb-uuid-2",
              name: "Unknown Grade",
              grades: {
                vscale: null,
                yds: null,
                ewbank: null,
                french: null,
                font: null,
                uiaa: null,
                brazilianCrux: null,
              },
              type: { trad: true, sport: false, bouldering: false },
              parent: { area_name: "Smith Rock" },
            },
          }),
        ],
      }),
    );
    const { db, climbingEntryValues } = makeDb();
    const provider = new OpenBetaProvider(fetchFn);

    const result = await provider.sync(makeRun(db));

    expect(result).toMatchObject({ provider: "openbeta", recordsSynced: 0 });
    expect(result.errors).toHaveLength(2);
    expect(result.degradations).toEqual([
      expect.objectContaining({
        kind: "record_rejected",
        providerId: "openbeta",
        stepName: "climbing_activity",
        context: { invalidDateCount: 1, unsupportedGradeCount: 1 },
      }),
    ]);
    expect(climbingEntryValues).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("requires a user context before loading provider state", async () => {
    const { db } = makeDb();
    const provider = new OpenBetaProvider(vi.fn());

    const result = await provider.sync(makeRunWithoutUser(db));

    expect(result).toMatchObject({
      provider: "openbeta",
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: "OpenBeta sync requires a user context." })],
    });
    expect(mocks.ensureProvider).not.toHaveBeenCalled();
    expect(mocks.loadTokens).not.toHaveBeenCalled();
  });

  it("reports when the public profile identity is not stored", async () => {
    mocks.loadTokens.mockResolvedValueOnce(null);
    const { db } = makeDb();
    const provider = new OpenBetaProvider(vi.fn());

    const result = await provider.sync(makeRun(db));

    expect(result).toMatchObject({
      provider: "openbeta",
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: expect.stringContaining("not found") })],
    });
  });

  it.each([502, 503, 504])("delegates HTTP %s tick failures to queue retries", async (status) => {
    const provider = new OpenBetaProvider(
      vi.fn().mockResolvedValue(new Response("upstream timeout", { status })),
    );
    const { db } = makeDb();

    await expect(provider.sync(makeRun(db))).rejects.toBeInstanceOf(
      ProviderServiceUnavailableError,
    );

    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("delegates request timeouts to queue retries", async () => {
    const error = new ProviderRequestTimeoutError({ providerId: "openbeta", timeoutMs: 120_000 });
    const provider = new OpenBetaProvider(vi.fn().mockRejectedValue(error));
    const { db } = makeDb();

    await expect(provider.sync(makeRun(db))).rejects.toMatchObject({
      name: "ProviderRequestTimeoutError",
      providerId: "openbeta",
      cause: error,
    });
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("captures tick export failures and returns their actionable message", async () => {
    const provider = new OpenBetaProvider(
      vi.fn().mockResolvedValue(new Response("", { status: 500 })),
    );
    const { db } = makeDb();

    const result = await provider.sync(makeRun(db));

    expect(result).toMatchObject({
      provider: "openbeta",
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: "OpenBeta API request failed (500)." })],
    });
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "OpenBeta API request failed (500)." }),
      { tags: { provider: "openbeta", phase: "tick_export" } },
    );
  });

  it("captures climbing-entry write failures", async () => {
    mocks.withSyncLog.mockRejectedValueOnce(new Error("climbing entry write failed"));
    const provider = new OpenBetaProvider(
      vi.fn().mockResolvedValue(graphqlResponse({ userTicks: [tick()] })),
    );
    const { db } = makeDb();

    const result = await provider.sync(makeRun(db));

    expect(result).toMatchObject({
      provider: "openbeta",
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: "climbing entry write failed" })],
    });
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "climbing entry write failed" }),
      { tags: { provider: "openbeta", phase: "climbing_activity" } },
    );
  });

  it("does not retire existing ticks after an empty public tick list", async () => {
    const { db } = makeDb();
    const provider = new OpenBetaProvider(
      vi.fn().mockResolvedValue(graphqlResponse({ userTicks: [] })),
    );

    const result = await provider.sync(makeRun(db));

    expect(result).toMatchObject({ provider: "openbeta", recordsSynced: 0, errors: [] });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("reports that OpenBeta is always configured and exposes manual profile auth", () => {
    const provider = new OpenBetaProvider(vi.fn());

    expect(provider.validate()).toBeNull();
    expect(provider.authSetup()).toMatchObject({
      apiBaseUrl: "https://api.openbeta.io",
      manualToken: {
        label: "OpenBeta profile URL or username",
        instructionsUrl: "https://openbeta.io/",
      },
    });
  });
});
