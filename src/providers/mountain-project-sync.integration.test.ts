import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activity } from "../db/schema/activity.ts";
import {
  area,
  climb,
  climbGrade,
  climbingAttempt,
  climbingLogEntry,
  climbingLogEntryGrade,
} from "../db/schema/climbing.ts";
import { TEST_USER_ID as userId } from "../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { MountainProjectProvider } from "./mountain-project.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

const fixtureCsv = readFileSync(
  join(import.meta.dirname, "fixtures/mountain-project-ticks.csv"),
  "utf8",
);
const server = setupServer();
const exportUrl = "https://www.mountainproject.com/user/110186720/ticks/tick-export";

describe("MountainProjectProvider canonical persistence", () => {
  let ctx: TestContext;
  let currentExport: string;
  beforeAll(async () => {
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(
      ctx.db,
      "mountain-project",
      "Mountain Project",
      "https://www.mountainproject.com",
      userId,
    );
    await saveTokens(
      ctx.db,
      "mountain-project",
      {
        accessToken: "110186720",
        refreshToken: null,
        expiresAt: new Date("2099-12-31T00:00:00Z"),
        scopes: "ticks",
      },
      userId,
    );
  });
  afterEach(async () => {
    server.resetHandlers();
    await ctx.db.delete(climbingLogEntry);
    await ctx.db.delete(climb);
    await ctx.db.update(area).set({ parentAreaId: null });
    await ctx.db.delete(area);
  });
  afterAll(async () => {
    server.close();
    await ctx.cleanup();
  });
  function run() {
    return new MountainProjectProvider().sync(
      new SyncRun({
        db: ctx.db,
        userId,
        window: SyncWindow.full(new Date("2026-08-11T00:00:00Z")),
      }),
    );
  }
  function serve() {
    server.use(
      http.get(
        exportUrl,
        () => new HttpResponse(currentExport, { headers: { "Content-Type": "text/csv" } }),
      ),
    );
  }
  function records() {
    return ctx.db
      .select({ log: climbingLogEntry, climb })
      .from(climbingLogEntry)
      .leftJoin(climb, eq(climb.id, climbingLogEntry.climbId));
  }

  it("maps source qualifiers and current shared metadata while preserving attachment and source date", async () => {
    currentExport = fixtureCsv;
    serve();
    await expect(run()).resolves.toMatchObject({ recordsSynced: 3, errors: [] });
    const before = await records();
    const west = before.find((row) => row.climb?.name === "West Overhang");
    if (!west) throw new Error("Expected West Overhang");
    expect(west.log).toMatchObject({
      activityId: null,
      climbedOn: "2026-08-10",
      notes: "placeholder note",
      discipline: "rock_climbing",
    });
    expect(west.climb).toMatchObject({ externalId: "105751342", kind: "route", setting: null });
    expect(
      await ctx.db
        .select()
        .from(climbGrade)
        .where(eq(climbGrade.climbId, west.log.climbId ?? "")),
    ).toEqual([expect.objectContaining({ system: "yds", value: "5.7", position: 0 })]);
    expect((await ctx.db.select().from(area)).map((row) => row.name)).toEqual(
      expect.arrayContaining(["Colorado", "Boulder", "Eldorado Canyon"]),
    );
    const attempts = await ctx.db
      .select()
      .from(climbingAttempt)
      .where(eq(climbingAttempt.climbingLogEntryId, west.log.id));
    expect(attempts).toEqual([
      expect.objectContaining({
        scope: "climb",
        ropeMethod: "lead",
        outcome: "completed",
        fellOrHung: false,
        usedAid: false,
        receivedBeta: false,
        attemptIndex: 1,
      }),
    ]);
    const [parent] = await ctx.db
      .insert(activity)
      .values({
        providerId: "mountain-project",
        userId,
        externalId: "manual-parent",
        canonicalType: "climbing",
        providerType: "manual",
        startedAt: new Date("2026-08-10T00:00:00Z"),
      })
      .returning();
    if (!parent) throw new Error("Expected parent");
    await ctx.db
      .update(climbingLogEntry)
      .set({ activityId: parent.id })
      .where(eq(climbingLogEntry.id, west.log.id));
    await expect(run()).resolves.toMatchObject({ recordsSynced: 3, errors: [] });
    expect((await records()).find((row) => row.log.id === west.log.id)?.log).toMatchObject({
      activityId: parent.id,
      climbedOn: "2026-08-10",
    });
    expect(
      await ctx.db
        .select()
        .from(climbingAttempt)
        .where(eq(climbingAttempt.climbingLogEntryId, west.log.id)),
    ).toEqual(attempts);
  });

  it("keeps repeated occurrences separate on one verified climb", async () => {
    const source = fixtureCsv.split("\n")[1];
    if (!source) throw new Error("Expected fixture tick");
    currentExport = [fixtureCsv.split("\n")[0], source, source].join("\n");
    serve();
    await expect(run()).resolves.toMatchObject({ recordsSynced: 2, errors: [] });
    const before = await records();
    expect(before).toHaveLength(2);
    expect(new Set(before.map((row) => row.log.externalId)).size).toBe(2);
    expect(new Set(before.map((row) => row.log.climbId)).size).toBe(1);
    await expect(run()).resolves.toMatchObject({ recordsSynced: 2, errors: [] });
    expect((await records()).map((row) => row.log.id).sort()).toEqual(
      before.map((row) => row.log.id).sort(),
    );
  });

  it("reconciles full lists while preserving records after incomplete empty or failed discovery", async () => {
    currentExport = fixtureCsv;
    serve();
    await run();
    currentExport = fixtureCsv
      .split("\n")
      .filter((line) => !line.includes("Jim Hall Left"))
      .join("\n");
    await expect(run()).resolves.toMatchObject({ recordsSynced: 2, errors: [] });
    expect(
      (await records()).find((row) => row.climb?.name === "Jim Hall Left")?.log.providerAbsentAt,
    ).toBeInstanceOf(Date);
    currentExport = fixtureCsv;
    await run();
    expect((await records()).every((row) => row.log.providerAbsentAt === null)).toBe(true);
    const valid = fixtureCsv.split("\n")[1];
    currentExport = [
      fixtureCsv.split("\n")[0],
      valid,
      "2026-02-30,Invalid,5.9,,https://www.mountainproject.com/route/1/invalid,1,Crag,2,-1,Lead,Redpoint,Trad,,,1800",
    ].join("\n");
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [expect.any(Object)] });
    expect((await records()).every((row) => row.log.providerAbsentAt === null)).toBe(true);
    currentExport = fixtureCsv.split("\n")[0] ?? "";
    await expect(run()).resolves.toMatchObject({ recordsSynced: 0, errors: [] });
    expect(await records()).toHaveLength(3);
    server.use(http.get(exportUrl, () => new HttpResponse("unavailable", { status: 503 })));
    await expect(run()).resolves.toMatchObject({ recordsSynced: 0, errors: [expect.any(Object)] });
    expect((await records()).every((row) => row.log.providerAbsentAt === null)).toBe(true);
  });

  it("retains missing grade date and location without inventing rock classification", async () => {
    currentExport = [
      fixtureCsv.split("\n")[0],
      ",Unknown summit,,Source note,https://www.mountainproject.com/route/123/unknown,1,,2,-1,,,,,,0",
    ].join("\n");
    serve();
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    const [record] = await records();
    expect(record?.log).toMatchObject({ climbedOn: null, discipline: null, notes: "Source note" });
    expect(record?.climb).toMatchObject({ areaId: null, setting: null });
    expect(await ctx.db.select().from(climbGrade)).toEqual([]);
    expect(await ctx.db.select().from(climbingAttempt)).toEqual([
      expect.objectContaining({ attemptIndex: null, outcome: null }),
    ]);
  });
  it("persists published compound grades separately from a supplied route rating opinion", async () => {
    currentExport = [
      fixtureCsv.split("\n")[0],
      "2026-08-10,Compound,5.10 A2,,https://www.mountainproject.com/route/123/compound,3,Crag,2,-1,Aid,Flash,Trad,5.9,,3000",
    ].join("\n");
    serve();
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    expect(
      (await ctx.db.select().from(climbGrade)).map(({ value, system, position }) => ({
        value,
        system,
        position,
      })),
    ).toEqual([
      { value: "5.10", system: "yds", position: 0 },
      { value: "A2", system: "aid", position: 1 },
    ]);
    expect(await ctx.db.select().from(climbingLogEntryGrade)).toEqual([
      expect.objectContaining({ value: "5.9", system: "yds", position: 0 }),
    ]);
    expect(await ctx.db.select().from(climbingAttempt)).toEqual([
      expect.objectContaining({
        scope: "climb",
        usedAid: true,
        fellOrHung: null,
        outcome: "completed",
        receivedBeta: true,
      }),
    ]);
  });
});
