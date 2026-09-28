import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { climbingEntry } from "../db/schema/activity.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

const USER_ID = "00000000-0000-0000-0000-000000000001";
const OPENBETA_USER_UUID = "51e4a2f9-93ca-44db-9efb-9bc663da6cbe";

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

function graphqlResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    headers: { "Content-Type": "application/json" },
  });
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
    dateClimbed: "2026-08-10",
    grade: "5.10a",
    source: "OB",
    user: { username: "climber", displayName: "Climber" },
    climb: {
      uuid: "climb-uuid-1",
      name: "Sunset Arete",
      grades: {
        vscale: null,
        yds: "5.10a",
        ewbank: null,
        french: null,
        font: null,
        uiaa: null,
        brazilianCrux: null,
      },
      type: { trad: true, sport: false, bouldering: false },
      parent: { area_name: "Smith Rock" },
    },
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

afterEach(() => {
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
            dateClimbed: "2026-08-11",
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
          sent: true,
          attemptCount: 1,
          routeName: "Sunset Arete",
          locationName: "Smith Rock",
          sourceName: "OpenBeta",
          raw: expect.objectContaining({ _id: "tick-1", source: "OB" }),
        }),
        expect.objectContaining({
          externalId: "openbeta:tick-2",
          unattachedDate: "2026-08-11",
          climbType: "boulder",
          gradeSystem: "v_scale",
          grade: "V4",
          sent: false,
          attemptCount: 1,
          locationName: "Smith Rock Boulders",
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

  it("does not reconcile when ticks are malformed or have unsupported grades", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      graphqlResponse({
        userTicks: [
          tick({ dateClimbed: "2026-02-30" }),
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
    expect(climbingEntryValues).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
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
});
