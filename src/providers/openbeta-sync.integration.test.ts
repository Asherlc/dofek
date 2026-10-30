import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  area,
  climb,
  climbGrade,
  climbingAttempt,
  climbingLogEntry,
  climbingLogEntryGrade,
  pitch,
  pitchGrade,
} from "../db/schema/climbing.ts";
import { TEST_USER_ID } from "../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { createIntegrationMswFixture } from "../test/early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { OpenBetaProvider } from "./openbeta.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import {
  OPENBETA_TEST_USER_UUID,
  openBetaClimb,
  openBetaGrades,
  openBetaTick,
} from "./test-helpers.ts";

const server = createIntegrationMswFixture();
describe("OpenBetaProvider canonical persistence", () => {
  let context: TestContext;
  let currentTicks: Record<string, unknown>[];
  beforeAll(async () => {
    context = await setupTestDatabase();
    server.activate({ onUnhandledFrame: failOnUnhandledExternalRequest });
    await ensureProvider(
      context.db,
      "openbeta",
      "OpenBeta",
      "https://api.openbeta.io",
      TEST_USER_ID,
    );
    await saveTokens(
      context.db,
      "openbeta",
      {
        accessToken: OPENBETA_TEST_USER_UUID,
        refreshToken: null,
        expiresAt: new Date("2099-12-31T00:00:00Z"),
        scopes: "ticks",
      },
      TEST_USER_ID,
    );
  });
  beforeEach(() => {
    currentTicks = [openBetaTick(), openBetaTick({ _id: "tick-repeat", attemptType: "Flash" })];
    server.use(
      http.post("https://api.openbeta.io", () =>
        HttpResponse.json({ data: { userTicks: currentTicks } }),
      ),
    );
  });
  afterEach(async () => {
    server.resetHandlers();
    await context.db.delete(climbingLogEntry);
    await context.db.delete(climb);
    await context.db.update(area).set({ parentAreaId: null });
    await context.db.delete(area);
  });
  afterAll(async () => {
    server.deactivate();
    await context.cleanup();
  });
  function run() {
    return new OpenBetaProvider().sync(
      new SyncRun({
        db: context.db,
        userId: TEST_USER_ID,
        window: SyncWindow.full(new Date("2026-08-11T00:00:00Z")),
      }),
    );
  }
  function records() {
    return context.db.select().from(climbingLogEntry).orderBy(climbingLogEntry.externalId);
  }

  it("retires every tick after a complete empty logbook and restores the same records", async () => {
    await expect(run()).resolves.toMatchObject({ recordsSynced: 2, errors: [] });
    const before = await records();
    const attempts = await context.db.select().from(climbingAttempt);
    const ticks = currentTicks;

    currentTicks = [];
    await expect(run()).resolves.toMatchObject({ recordsSynced: 0, errors: [] });
    expect(await records()).toEqual(
      before.map((entry) => ({ ...entry, providerAbsentAt: expect.any(Date) })),
    );
    expect(await context.db.select().from(climbingAttempt)).toEqual(attempts);

    currentTicks = ticks;
    await expect(run()).resolves.toMatchObject({ recordsSynced: 2, errors: [] });
    expect(await records()).toEqual(before);
  });

  it("keeps repeated occurrences separate on one verified climb and reconciles complete lists", async () => {
    await expect(run()).resolves.toMatchObject({ recordsSynced: 2, errors: [] });
    const before = await records();
    expect(before).toHaveLength(2);
    expect(new Set(before.map((row) => row.climbId)).size).toBe(1);
    expect(await context.db.select().from(climb)).toEqual([
      expect.objectContaining({ externalId: "climb-uuid-1", name: "Sunset Arete", setting: null }),
    ]);
    expect(await context.db.select().from(climbGrade)).toEqual([
      expect.objectContaining({ value: "5.10a", system: "yds" }),
    ]);
    const flash = before.find((row) => row.externalId === "openbeta:tick-repeat");
    if (!flash) throw new Error("Expected Flash");
    expect(
      await context.db
        .select()
        .from(climbingAttempt)
        .where(eq(climbingAttempt.climbingLogEntryId, flash.id)),
    ).toEqual([
      expect.objectContaining({
        sourceResult: "Flash",
        fellOrHung: false,
        usedAid: false,
        receivedBeta: null,
        attemptIndex: 1,
      }),
    ]);
    await expect(run()).resolves.toMatchObject({ recordsSynced: 2, errors: [] });
    expect(await records()).toEqual(before);
    currentTicks = [openBetaTick()];
    await run();
    expect((await records()).find((row) => row.id === flash.id)?.providerAbsentAt).toBeInstanceOf(
      Date,
    );
    currentTicks = [];
    await run();
    expect(
      (await records()).find((row) => row.externalId === "openbeta:tick-1")?.providerAbsentAt,
    ).toBeInstanceOf(Date);
    currentTicks = [openBetaTick({ _id: "tick-repeat", attemptType: "Flash" })];
    await run();
    expect((await records()).find((row) => row.id === flash.id)?.providerAbsentAt).toBeNull();
  });

  it("stores separate climb and containing area native points and updates their shared hierarchy", async () => {
    currentTicks = [
      openBetaTick({
        climb: openBetaClimb({
          metadata: { lat: 0, lng: -122.25 },
          pathTokens: ["Country", "Wall"],
          ancestors: ["area-country", "area-wall"],
          parent: { uuid: "area-wall", area_name: "Wall", metadata: { lat: 37.5, lng: 0 } },
        }),
      }),
    ];
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    const [definition] = await context.db.select().from(climb);
    expect(definition?.coordinates).toEqual({ x: -122.25, y: 0 });
    expect(await context.db.select().from(area).where(eq(area.externalId, "area-wall"))).toEqual([
      expect.objectContaining({ coordinates: { x: 0, y: 37.5 }, name: "Wall" }),
    ]);
    currentTicks = [
      openBetaTick({
        climb: openBetaClimb({
          name: "Renamed climb",
          pathTokens: ["Country", "Renamed wall"],
          ancestors: ["area-country", "area-wall"],
          parent: { uuid: "area-wall", area_name: "Renamed wall" },
        }),
      }),
    ];
    await run();
    expect(await context.db.select().from(climb)).toEqual([
      expect.objectContaining({
        id: definition?.id,
        name: "Renamed climb",
        coordinates: { x: -122.25, y: 0 },
      }),
    ]);
    expect(await context.db.select().from(area).where(eq(area.externalId, "area-wall"))).toEqual([
      expect.objectContaining({ name: "Renamed wall", coordinates: { x: 0, y: 37.5 } }),
    ]);
  });

  it("retains nullable dates grades and classifications", async () => {
    currentTicks = [
      openBetaTick({ climb: null, grade: null, dateClimbed: null, style: null, attemptType: null }),
    ];
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await records()).toEqual([
      expect.objectContaining({ climbedOn: null, discipline: null }),
    ]);
    expect(await context.db.select().from(climb)).toEqual([
      expect.objectContaining({ externalId: null, kind: null, setting: null }),
    ]);
    expect(await context.db.select().from(climbGrade)).toEqual([]);
    expect(await context.db.select().from(climbingAttempt)).toEqual([
      expect.objectContaining({ sourceResult: null, fellOrHung: null, attemptIndex: null }),
    ]);
  });
  it("retains an unmatched tick name without overwriting a shared catalogue name", async () => {
    currentTicks = [openBetaTick({ name: "Recorded local route", climb: null, climbId: null })];
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await context.db.select().from(climb)).toEqual([
      expect.objectContaining({ externalId: null, name: "Recorded local route" }),
    ]);
    currentTicks = [
      openBetaTick({
        _id: "matched",
        name: "Old tick snapshot",
        climb: openBetaClimb({ name: "Current catalogue route" }),
      }),
    ];
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    expect(
      await context.db.select().from(climb).where(eq(climb.externalId, "climb-uuid-1")),
    ).toEqual([expect.objectContaining({ name: "Current catalogue route" })]);
  });
  it("persists catalogue pitch grades and all route scales independently of the tick grade", async () => {
    currentTicks = [
      openBetaTick({
        grade: "5.9",
        climb: openBetaClimb({
          grades: openBetaGrades({ french: "6a" }),
          pitches: [
            {
              id: "pitch-one",
              parentId: "climb-uuid-1",
              pitchNumber: 1,
              grades: openBetaGrades({ yds: "5.8" }),
            },
          ],
        }),
      }),
    ];
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    expect(
      (await context.db.select().from(climbGrade)).map(({ value, system }) => ({ value, system })),
    ).toEqual([
      { value: "5.10a", system: "yds" },
      { value: "6a", system: "french" },
    ]);
    expect(await context.db.select().from(climbingLogEntryGrade)).toEqual([
      expect.objectContaining({ value: "5.9", system: "yds" }),
    ]);
    expect(await context.db.select().from(pitch)).toEqual([
      expect.objectContaining({ externalId: "pitch-one", number: 1, name: null }),
    ]);
    expect(await context.db.select().from(pitchGrade)).toEqual([
      expect.objectContaining({ value: "5.8", system: "yds" }),
    ]);
    expect(await context.db.select().from(climbingAttempt)).toEqual([
      expect.objectContaining({ scope: "climb", pitchId: null }),
    ]);
  });
  it("retains a verified OpenBeta target reference when catalogue metadata is missing", async () => {
    const target = "9b41b2f4-d4dc-4540-b7fc-e629d00a9e51";
    currentTicks = [
      openBetaTick({
        climbId: target,
        source: "OB",
        climb: openBetaClimb({
          uuid: target,
          name: "Current catalogue name",
          type: { bouldering: false, sport: true, trad: false },
        }),
      }),
    ];
    await run();
    const [before] = await records();
    currentTicks = [
      openBetaTick({ climbId: target, source: "OB", name: "Historical tick name", climb: null }),
    ];
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    expect((await records())[0]?.climbId).toBe(before?.climbId);
    expect(await context.db.select().from(climb).where(eq(climb.externalId, target))).toEqual([
      expect.objectContaining({ name: "Current catalogue name", routeProtection: ["sport"] }),
    ]);
    currentTicks = [
      openBetaTick({
        _id: "imported",
        source: "MP",
        climbId: "105734660",
        name: "Imported recorded route",
        climb: null,
      }),
    ];
    await run();
    expect(
      await context.db.select().from(climb).where(eq(climb.name, "Imported recorded route")),
    ).toEqual([expect.objectContaining({ externalId: null })]);
  });

  it("preserves records after invalid hierarchy or incomplete discovery", async () => {
    await run();
    const before = await records();
    currentTicks = [
      openBetaTick({
        climb: openBetaClimb({ pathTokens: ["Crag", "Wall"], ancestors: ["area-one"] }),
      }),
    ];
    await expect(run()).resolves.toMatchObject({
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: expect.stringContaining("location path") })],
    });
    expect(await records()).toEqual(before);
    currentTicks = [
      openBetaTick(),
      openBetaTick({ _id: "invalid-date", dateClimbed: 253402300800000 }),
    ];
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [expect.any(Object)] });
    expect(await records()).toEqual(before);
    server.use(
      http.post("https://api.openbeta.io", () =>
        HttpResponse.json({ errors: [{ message: "Source unavailable" }] }),
      ),
    );
    await expect(run()).resolves.toMatchObject({ recordsSynced: 0, errors: [expect.any(Object)] });
    expect(await records()).toEqual(before);
  });
  it.each([253402300800000, -62167219200001, -62167219200000])(
    "rejects supplied dates outside PostgreSQL calendar bounds %s",
    async (dateClimbed) => {
      currentTicks = [openBetaTick(), openBetaTick({ _id: "invalid-date", dateClimbed })];
      await expect(run()).resolves.toMatchObject({
        recordsSynced: 1,
        errors: [
          expect.objectContaining({
            externalId: "invalid-date",
            message: expect.stringContaining("invalid date"),
          }),
        ],
      });
      expect(await records()).toEqual([
        expect.objectContaining({ externalId: "openbeta:tick-1", climbedOn: "2026-08-10" }),
      ]);
    },
  );
});
