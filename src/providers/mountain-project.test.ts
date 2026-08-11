import { afterEach, describe, expect, it, vi } from "vitest";
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
  upsertProviderActivity: vi.fn().mockResolvedValue({ id: "activity-1" }),
  finishProviderActivityListSync: vi.fn().mockResolvedValue(undefined),
  withSyncLog: vi.fn(async (_db, _providerId, _dataType, callback) => (await callback()).result),
  captureException: vi.fn(),
}));

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: mocks.ensureProvider,
  loadTokens: mocks.loadTokens,
}));
vi.mock("../db/provider-activity-sync.ts", () => ({
  upsertProviderActivity: mocks.upsertProviderActivity,
  finishProviderActivityListSync: mocks.finishProviderActivityListSync,
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
  const climbingEntryValues = vi.fn().mockResolvedValue(undefined);
  return {
    db: {
      insert: vi.fn().mockReturnValue({ values: climbingEntryValues }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      select: vi.fn(),
      execute: vi.fn(),
    },
    climbingEntryValues,
  };
}

function makeRun(db: ReturnType<typeof makeDb>["db"]): SyncRun {
  return new SyncRun({
    db,
    window: SyncWindow.full(new Date("2026-08-11T00:00:00.000Z")),
    userId: "00000000-0000-0000-0000-000000000001",
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
  mocks.upsertProviderActivity.mockResolvedValue({ id: "activity-1" });
  mocks.withSyncLog.mockImplementation(
    async (_db, _providerId, _dataType, callback) => (await callback()).result,
  );
});

describe("MountainProjectProvider", () => {
  it("uses a profile URL manual-token connection without OAuth credentials", async () => {
    const provider = new MountainProjectProvider(async () => new Response(exportCsv([])));
    const setup = provider.authSetup();

    await expect(
      setup.manualToken?.exchangeToken("https://www.mountainproject.com/user/110186720/example"),
    ).resolves.toMatchObject({ accessToken: "110186720", scopes: "ticks" });
    expect(setup.oauthConfig).toBeUndefined();
    expect(setup.automatedLogin).toBeUndefined();
  });

  it("groups valid rows by crag-day and maps sent, null attempts, raw notes, and unrated stars", async () => {
    const csv = exportCsv([
      '2026-08-10,"West Overhang",5.7,"2:1 W/TMG",https://www.mountainproject.com/route/105751342/west-overhang,1,"Colorado > Boulder > Eldorado Canyon",2.4,-1,Lead,Onsight,Trad,,,1800',
      '2026-08-10,"Still My Way",5.10b/c,,https://www.mountainproject.com/route/110994870/still-my-way,1,"Colorado > Boulder > Eldorado Canyon",2.2,2,TR,,Sport,,40,1800',
      '2026-08-10,"Jim Hall Left",V0,,https://www.mountainproject.com/route/110000001/jim-hall-left,1,"Colorado > Boulder > Flagstaff",2.0,3,Flash,,Boulder,,,20008',
    ]);
    const { db, climbingEntryValues } = makeDb();
    const provider = new MountainProjectProvider(async () => new Response(csv));

    const result = await provider.sync(makeRun(db));

    expect(result).toMatchObject({ provider: "mountain-project", recordsSynced: 3, errors: [] });
    expect(mocks.upsertProviderActivity).toHaveBeenCalledTimes(2);
    expect(climbingEntryValues).toHaveBeenCalledTimes(2);
    const firstSessionEntries = climbingEntryValues.mock.calls[0]?.[0];
    expect(firstSessionEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          climbType: "route",
          gradeSystem: "yds",
          grade: "5.7",
          sent: true,
          attemptCount: 1,
          routeName: "West Overhang",
          locationName: "Colorado > Boulder > Eldorado Canyon",
          raw: expect.objectContaining({ Notes: "2:1 W/TMG", "Your Stars": "-1" }),
        }),
        expect.objectContaining({ sent: null, attemptCount: null, grade: "5.10b" }),
      ]),
    );
  });

  it("assigns unique stable external IDs to repeated same-day laps", async () => {
    const row =
      '2026-08-10,"West Overhang",5.7,,https://www.mountainproject.com/route/105751342/west-overhang,1,"Colorado > Boulder > Eldorado Canyon",2.4,-1,Lead,Redpoint,Trad,,,1800';
    const { db, climbingEntryValues } = makeDb();
    const provider = new MountainProjectProvider(async () => new Response(exportCsv([row, row])));

    await provider.sync(makeRun(db));

    const entries = climbingEntryValues.mock.calls[0]?.[0];
    expect(Array.isArray(entries)).toBe(true);
    if (!Array.isArray(entries)) throw new Error("expected climbing entry array");
    const externalIds = entries.map((entry) => {
      if (typeof entry !== "object" || entry === null || !("externalId" in entry)) {
        throw new Error("expected climbing entry external ID");
      }
      return entry.externalId;
    });
    expect(externalIds).toHaveLength(2);
    expect(externalIds[0]).not.toBe(externalIds[1]);
  });

  it("reports unsupported grades once and reconciles only valid activities", async () => {
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
    expect(mocks.upsertProviderActivity).not.toHaveBeenCalled();
    expect(mocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ presentExternalIds: new Set() }),
    );
  });

  it("does not reconcile when the public export request fails", async () => {
    const { db } = makeDb();
    const provider = new MountainProjectProvider(
      async () => new Response("unavailable", { status: 503 }),
    );

    const result = await provider.sync(makeRun(db));

    expect(result.errors[0]?.message).toContain("tick export failed (503)");
    expect(mocks.finishProviderActivityListSync).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalled();
  });
});
