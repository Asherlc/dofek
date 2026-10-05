import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { climbingEntry } from "../db/schema/activity.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

const mocks = vi.hoisted(() => ({
  ensureProvider: vi.fn().mockResolvedValue(undefined),
  loadTokens: vi.fn().mockResolvedValue({
    accessToken: "110186720",
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

import { MountainProjectProvider } from "./mountain-project.ts";

const header =
  'Date,Route,Rating,Notes,URL,Pitches,Location,"Avg Stars","Your Stars",Style,"Lead Style","Route Type","Your Rating",Length,"Rating Code"';

function exportCsv(rows: string[]): string {
  return [header, ...rows].join("\n");
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

function makeRun(
  db: ReturnType<typeof makeDb>["db"],
  userId: string | null = "00000000-0000-0000-0000-000000000001",
): SyncRun {
  return new SyncRun({
    db,
    window: SyncWindow.full(new Date("2026-08-11T00:00:00.000Z")),
    userId: userId ?? undefined,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.loadTokens.mockResolvedValue({
    accessToken: "110186720",
    refreshToken: null,
    expiresAt: new Date("2099-12-31T00:00:00.000Z"),
    scopes: "ticks",
  });
  mocks.withSyncLog.mockImplementation(
    async (_db, _providerId, _dataType, callback) => (await callback()).result,
  );
});

describe("MountainProjectProvider", () => {
  it("preserves nonempty path nodes and leaves a boulder's rope method unknown", async () => {
    const { db, climbingEntryValues } = makeDb();
    const csv = exportCsv([
      '2026-08-10,Context Boulder,V4,,https://www.mountainproject.com/route/100/context,1," Country > > Wall > ",2.4,-1,Lead,,Boulder,,,20400',
    ]);
    const result = await new MountainProjectProvider(async () => new Response(csv)).sync(
      makeRun(db),
    );
    expect(result).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(climbingEntryValues).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        climbType: "boulder",
        climbStyle: null,
        resultStyle: "Lead",
        locationPath: [
          { name: "Country", externalId: null, kind: null },
          { name: "Wall", externalId: null, kind: null },
        ],
      }),
    );
  });
  it.each([
    ["Lead", "lead"],
    ["TR", "top-rope"],
    ["Follow", "follow"],
    ["Solo", "solo"],
    ["Aid", "aid"],
  ])("preserves %s and six location levels independently of a result", async (style, method) => {
    const { db, climbingEntryValues } = makeDb();
    const csv = exportCsv([
      `2026-08-10,Context Route,5.9,,https://www.mountainproject.com/route/100/context,1,"Country > State > Region > Park > Crag > Wall",2.4,-1,${style},Fell/Hung,Trad,,,1800`,
    ]);
    const result = await new MountainProjectProvider(async () => new Response(csv)).sync(
      makeRun(db),
    );
    expect(result.errors).toEqual([]);
    expect(climbingEntryValues).toHaveBeenCalledWith(
      expect.objectContaining({
        climbStyle: method,
        routeProtection: ["trad"],
        resultStyle: "Fell/Hung",
        attemptCount: null,
        locationPath: ["Country", "State", "Region", "Park", "Crag", "Wall"].map((name) => ({
          name,
          externalId: null,
          kind: null,
        })),
        board: null,
        wallAngle: null,
      }),
    );
  });
  it("returns an actionable error without persisting when no user context is available", async () => {
    const { db } = makeDb();
    const provider = new MountainProjectProvider(vi.fn());

    const result = await provider.sync(makeRun(db, null));

    expect(result).toMatchObject({
      provider: "mountain-project",
      recordsSynced: 0,
      errors: [
        expect.objectContaining({ message: "Mountain Project sync requires a user context." }),
      ],
    });
    expect(mocks.ensureProvider).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("uses a profile URL manual-token connection without OAuth credentials", async () => {
    const provider = new MountainProjectProvider(async () => new Response(exportCsv([])));
    const setup = provider.authSetup();

    await expect(
      setup.manualToken?.exchangeToken("https://www.mountainproject.com/user/110186720/example"),
    ).resolves.toMatchObject({ accessToken: "110186720", scopes: "ticks" });
    expect(setup.oauthConfig).toBeUndefined();
    expect(setup.automatedLogin).toBeUndefined();
  });

  it("rejects a profile connection when the public endpoint does not return a tick export", async () => {
    const provider = new MountainProjectProvider(async () => new Response("not a CSV"));

    await expect(provider.authSetup().manualToken?.exchangeToken("110186720")).rejects.toThrow(
      "Paste your public Mountain Project profile URL",
    );
  });

  it("returns an actionable error without fetching when the stored profile identity is missing", async () => {
    mocks.loadTokens.mockResolvedValueOnce(null);
    const { db } = makeDb();
    const provider = new MountainProjectProvider(vi.fn());

    const result = await provider.sync(makeRun(db));

    expect(provider.validate()).toBeNull();
    expect(result).toMatchObject({
      provider: "mountain-project",
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: expect.stringContaining("profile connection") })],
    });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("persists one standalone climbing entry per supported tick", async () => {
    const csv = exportCsv([
      '2026-08-10,"West Overhang",5.7,"2:1 W/TMG",https://www.mountainproject.com/route/105751342/west-overhang,1,"Colorado > Boulder > Eldorado Canyon",2.4,-1,Lead,Onsight,Trad,,,1800',
      '2026-08-10,"Still My Way",5.10b/c,,https://www.mountainproject.com/route/110994870/still-my-way,1,"Colorado > Boulder > Eldorado Canyon",2.2,2,TR,,Sport,,40,1800',
      '2026-08-10,"Jim Hall Left",V0,,https://www.mountainproject.com/route/110000001/jim-hall-left,1,"Colorado > Boulder > Flagstaff",2.0,3,Flash,,Boulder,,,20008',
    ]);
    const { db, climbingEntryValues } = makeDb();
    const provider = new MountainProjectProvider(async () => new Response(csv));

    const result = await provider.sync(makeRun(db));

    expect(result).toMatchObject({ provider: "mountain-project", recordsSynced: 3, errors: [] });
    expect(climbingEntryValues).toHaveBeenCalledTimes(3);
    const values = climbingEntryValues.mock.calls.map(([value]) => value);
    expect(values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: "00000000-0000-0000-0000-000000000001",
          providerId: "mountain-project",
          activityId: null,
          unattachedDate: "2026-08-10",
          externalId: expect.stringMatching(/^mountain-project:tick:/),
          climbType: "route",
          gradeSystem: "yds",
          grade: "5.7",
          resultStyle: "Onsight",
          attemptCount: null,
          routeName: "West Overhang",
          locationPath: [
            { name: "Colorado", externalId: null, kind: null },
            { name: "Boulder", externalId: null, kind: null },
            { name: "Eldorado Canyon", externalId: null, kind: null },
          ],
          raw: expect.objectContaining({ Notes: "2:1 W/TMG", "Your Stars": "-1" }),
        }),
        expect.objectContaining({ resultStyle: null, attemptCount: null, grade: "5.10b" }),
      ]),
    );
    expect(db.execute).toHaveBeenCalledOnce();
    const reconciliationQuery = db.execute.mock.calls[0]?.[0];
    if (!(reconciliationQuery instanceof SQL)) throw new Error("Expected reconciliation SQL");
    const reconciliation = new PgDialect().sqlToQuery(reconciliationQuery);
    expect(reconciliation.params).toContain(values[0]?.externalId);
  });

  it("does not reconcile prior ticks from an empty export", async () => {
    const { db } = makeDb();
    const provider = new MountainProjectProvider(async () => new Response(exportCsv([])));

    const result = await provider.sync(makeRun(db));

    expect(result).toMatchObject({ recordsSynced: 0, errors: [] });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("assigns unique stable external IDs to repeated same-day laps", async () => {
    const row =
      '2026-08-10,"West Overhang",5.7,,https://www.mountainproject.com/route/105751342/west-overhang,1,"Colorado > Boulder > Eldorado Canyon",2.4,-1,Lead,Redpoint,Trad,,,1800';
    const { db, climbingEntryValues } = makeDb();
    const provider = new MountainProjectProvider(async () => new Response(exportCsv([row, row])));

    await provider.sync(makeRun(db));

    const externalIds = climbingEntryValues.mock.calls.map(([entry]) => entry.externalId);
    expect(externalIds).toHaveLength(2);
    expect(externalIds[0]).not.toBe(externalIds[1]);
  });

  it("validates rows, classifies every sent state, and falls back to Rating Code for boulders", async () => {
    const csv = exportCsv([
      '2026-02-30,"Impossible Date",5.7,,https://www.mountainproject.com/route/1/impossible,1,"Colorado > Boulder",2.4,-1,Lead,Onsight,Trad,,,1800',
      '2026/08/10,"Bad Date",5.7,,https://www.mountainproject.com/route/2/bad-date,1,"Colorado > Boulder",2.4,-1,Lead,Onsight,Trad,,,1800',
      '2026-08-10,"No Location",5.7,,https://www.mountainproject.com/route/3/no-location,1,"   ",2.4,-1,Lead,Onsight,Trad,,,1800',
      '2026-08-10,"Code Boulder",V2,,https://www.mountainproject.com/route/4/code-boulder,1," Colorado > Boulder ",2.4,-1,Attempt,,Trad,,,20000',
      '2026-08-10,"Typed Boulder",V1,,https://www.mountainproject.com/route/5/typed-boulder,1,"Colorado > Boulder",2.4,-1,Send,,Boulder,,,0',
      '2026-08-10,"Unknown Boulder",V0,,https://www.mountainproject.com/route/6/unknown-boulder,1,"Colorado > Boulder",2.4,-1,,,,,,20008',
      '2026-08-10,"Fell Route",5.9,,https://www.mountainproject.com/route/7/fell-route,1,"Colorado > Boulder",2.4,-1,Lead,Fell/Hung,Trad,,,1800',
      '2026-08-10,"Unknown Route",5.8,,https://www.mountainproject.com/route/8/unknown-route,1,"Colorado > Boulder",2.4,-1,TR,,Sport,,,1800',
      '2026-08-10,"  ",5.6,,https://www.mountainproject.com/route/9/no-name,1,"Colorado > Boulder",2.4,-1,Lead,Redpoint,Trad,,,1800',
    ]);
    const { db, climbingEntryValues } = makeDb();
    const result = await new MountainProjectProvider(async () => new Response(csv)).sync(
      makeRun(db),
    );

    expect(result.recordsSynced).toBe(6);
    expect(result.errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining("invalid date: 2026-02-30") }),
      expect.objectContaining({ message: expect.stringContaining("invalid date: 2026/08/10") }),
      expect.objectContaining({ message: expect.stringContaining("No Location") }),
    ]);
    const entries = climbingEntryValues.mock.calls.flatMap(([values]) => values);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeName: "Code Boulder",
          climbType: "boulder",
          resultStyle: "Attempt",
          attemptCount: null,
          locationPath: [
            { name: "Colorado", externalId: null, kind: null },
            { name: "Boulder", externalId: null, kind: null },
          ],
        }),
        expect.objectContaining({
          routeName: "Typed Boulder",
          climbType: "boulder",
          resultStyle: "Send",
          attemptCount: null,
        }),
        expect.objectContaining({
          routeName: "Unknown Boulder",
          climbType: "boulder",
          resultStyle: null,
          attemptCount: null,
        }),
        expect.objectContaining({
          routeName: "Fell Route",
          climbType: "route",
          climbStyle: "lead",
          resultStyle: "Fell/Hung",
          attemptCount: null,
        }),
        expect.objectContaining({
          routeName: "Unknown Route",
          climbType: "route",
          climbStyle: "top-rope",
          resultStyle: null,
          attemptCount: null,
        }),
        expect.objectContaining({
          routeName: null,
          climbType: "route",
          resultStyle: "Redpoint",
          attemptCount: null,
        }),
      ]),
    );
  });

  it("restores a returning tick without replacing attachment or standalone date", async () => {
    const csv = exportCsv([
      '2026-08-10,"West Overhang",5.7,,https://www.mountainproject.com/route/105751342/west-overhang,1,"Colorado > Boulder",2.4,-1,Lead,Redpoint,Trad,,,1800',
    ]);
    const { db, climbingEntryValues, conflictUpdates } = makeDb();
    const result = await new MountainProjectProvider(async () => new Response(csv)).sync(
      makeRun(db),
    );

    expect(result.recordsSynced).toBe(1);
    expect(climbingEntryValues).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalled();
    expect(conflictUpdates).toHaveBeenCalledWith(
      expect.objectContaining({
        target: [climbingEntry.userId, climbingEntry.providerId, climbingEntry.externalId],
        set: expect.objectContaining({ providerAbsentAt: null, raw: expect.any(Object) }),
      }),
    );
    const conflictSet = conflictUpdates.mock.calls[0]?.[0].set;
    expect(conflictSet).not.toHaveProperty("activityId");
    expect(conflictSet).not.toHaveProperty("unattachedDate");
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("reports unsupported grades and does not reconcile an unsupported-only export", async () => {
    const csv = exportCsv([
      '2026-08-10,"Ice Route",WI4,,https://www.mountainproject.com/route/110000002/ice-route,1,"Colorado > Boulder > Eldorado Canyon",2.4,-1,Lead,Onsight,Ice,,,0',
      '2026-08-10,"Mixed Route",M6+,,https://www.mountainproject.com/route/110000003/mixed-route,1,"Colorado > Boulder > Eldorado Canyon",2.4,-1,Lead,Onsight,Mixed,,,0',
    ]);
    const { db } = makeDb();
    const provider = new MountainProjectProvider(async () => new Response(csv));

    const result = await provider.sync(makeRun(db));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        message: "Skipped 2 Mountain Project ticks with unsupported grades.",
      }),
    ]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a partially invalid export",
      '2026-02-30,"Invalid Date",5.7,,https://www.mountainproject.com/route/1/invalid,1,"Colorado > Boulder",2.4,-1,Lead,Redpoint,Trad,,,1800',
    ],
    [
      "an export with an unsupported tick",
      '2026-08-10,"Ice Route",WI4,,https://www.mountainproject.com/route/2/ice,1,"Colorado > Boulder",2.4,-1,Lead,Onsight,Ice,,,0',
    ],
  ])("does not reconcile absent IDs from %s", async (_case, skippedRow) => {
    const validRow =
      '2026-08-10,"West Overhang",5.7,,https://www.mountainproject.com/route/105751342/west-overhang,1,"Colorado > Boulder",2.4,-1,Lead,Redpoint,Trad,,,1800';
    const { db } = makeDb();
    const provider = new MountainProjectProvider(
      async () => new Response(exportCsv([validRow, skippedRow])),
    );

    const result = await provider.sync(makeRun(db));

    expect(result.recordsSynced).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("does not reconcile when the public export request fails", async () => {
    const { db } = makeDb();
    const provider = new MountainProjectProvider(
      async () => new Response("unavailable", { status: 503 }),
    );

    const result = await provider.sync(makeRun(db));

    expect(result.errors[0]?.message).toContain("tick export failed (503)");
    expect(db.execute).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it("does not report an expected missing public export to Sentry", async () => {
    const { db } = makeDb();
    const provider = new MountainProjectProvider(
      async () => new Response("not found", { status: 404 }),
    );

    const result = await provider.sync(makeRun(db));

    expect(result.errors[0]?.message).toContain("couldn't read your ticks");
    expect(db.execute).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("reports and captures persistence failures without reconciling an incomplete write", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_100);
    const { db, insert } = makeDb();
    insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockRejectedValue(new Error("database offline")),
      }),
    });
    const provider = new MountainProjectProvider(
      async () =>
        new Response(
          exportCsv([
            '2026-08-10,"West Overhang",5.7,,https://www.mountainproject.com/route/105751342/west-overhang,1,"Colorado > Boulder",2.4,-1,Lead,Redpoint,Trad,,,1800',
          ]),
        ),
    );

    const result = await provider.sync(makeRun(db));

    try {
      expect(result).toMatchObject({
        recordsSynced: 0,
        errors: [expect.objectContaining({ message: "database offline" })],
      });
      expect(result.duration).toBe(100);
    } finally {
      now.mockRestore();
    }
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "database offline" }),
      { tags: { provider: "mountain-project", phase: "climbing_activity" } },
    );
  });
});
