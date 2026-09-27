import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activity, climbingEntry } from "../db/schema/activity.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { MountainProjectProvider } from "./mountain-project.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

const userId = "00000000-0000-0000-0000-000000000001";
const fixtureCsv = readFileSync(
  join(import.meta.dirname, "fixtures/mountain-project-ticks.csv"),
  "utf8",
);
const server = setupServer();

describe("MountainProjectProvider.sync() (integration)", () => {
  let ctx: TestContext;
  let currentExport = fixtureCsv;

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
  }, 60_000);

  afterEach(() => {
    currentExport = fixtureCsv;
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("upserts independent ticks, preserves attachment, and reconciles absence and restoration", async () => {
    await saveTokens(
      ctx.db,
      "mountain-project",
      {
        accessToken: "110186720",
        refreshToken: null,
        expiresAt: new Date("2099-12-31T00:00:00.000Z"),
        scopes: "ticks",
      },
      userId,
    );
    server.use(
      http.get(
        "https://www.mountainproject.com/user/110186720/ticks/tick-export",
        () => new HttpResponse(currentExport, { headers: { "Content-Type": "text/csv" } }),
      ),
    );

    const provider = new MountainProjectProvider();
    const run = () =>
      provider.sync(
        new SyncRun({
          db: ctx.db,
          window: SyncWindow.full(new Date("2026-08-11T00:00:00.000Z")),
          userId,
        }),
      );

    await expect(run()).resolves.toMatchObject({ recordsSynced: 3, errors: [] });
    await expect(run()).resolves.toMatchObject({ recordsSynced: 3, errors: [] });

    let activities = await ctx.db
      .select()
      .from(activity)
      .where(and(eq(activity.providerId, "mountain-project"), eq(activity.userId, userId)));
    expect(activities).toHaveLength(0);
    let entries = await ctx.db.select().from(climbingEntry);
    expect(entries).toHaveLength(3);
    const west = entries.find((entry) => entry.routeName === "West Overhang");
    expect(west).toMatchObject({
      activityId: null,
      unattachedDate: "2026-08-10",
      sent: true,
      attemptCount: 1,
      gradeSystem: "yds",
      grade: "5.7",
    });

    const [parent] = await ctx.db
      .insert(activity)
      .values({
        providerId: "mountain-project",
        userId,
        externalId: "manually-created-parent",
        canonicalType: "climbing",
        providerType: "manual",
        modality: null,
        startedAt: new Date("2026-08-10T00:00:00.000Z"),
        name: "Manual climbing session",
      })
      .returning({ id: activity.id });
    if (!parent || !west) throw new Error("expected parent activity and Mountain Project tick");
    await ctx.db
      .update(climbingEntry)
      .set({ activityId: parent.id, unattachedDate: null })
      .where(eq(climbingEntry.id, west.id));
    await expect(run()).resolves.toMatchObject({ recordsSynced: 3, errors: [] });
    entries = await ctx.db.select().from(climbingEntry);
    expect(entries.find((entry) => entry.id === west.id)).toMatchObject({
      activityId: parent.id,
      unattachedDate: null,
      raw: expect.objectContaining({ Notes: "placeholder note" }),
    });

    currentExport = fixtureCsv
      .split("\n")
      .filter((line) => !line.includes("Jim Hall Left"))
      .join("\n");
    await expect(run()).resolves.toMatchObject({ recordsSynced: 2, errors: [] });
    entries = await ctx.db.select().from(climbingEntry);
    const missing = entries.find((entry) => entry.routeName === "Jim Hall Left");
    expect(entries).toHaveLength(3);
    expect(missing?.providerAbsentAt).toBeInstanceOf(Date);
    expect(entries.find((entry) => entry.id === west.id)?.activityId).toBe(parent.id);

    currentExport = fixtureCsv;
    await expect(run()).resolves.toMatchObject({ recordsSynced: 3, errors: [] });
    entries = await ctx.db.select().from(climbingEntry);
    expect(
      entries.find((entry) => entry.routeName === "Jim Hall Left")?.providerAbsentAt,
    ).toBeNull();
    activities = await ctx.db
      .select()
      .from(activity)
      .where(and(eq(activity.providerId, "mountain-project"), eq(activity.userId, userId)));
    expect(activities).toHaveLength(1);
  });

  it("does not retire existing ticks after an empty or failed export", async () => {
    await saveTokens(
      ctx.db,
      "mountain-project",
      {
        accessToken: "110186720",
        refreshToken: null,
        expiresAt: new Date("2099-12-31T00:00:00.000Z"),
        scopes: "ticks",
      },
      userId,
    );
    server.use(
      http.get(
        "https://www.mountainproject.com/user/110186720/ticks/tick-export",
        () => new HttpResponse(currentExport, { headers: { "Content-Type": "text/csv" } }),
      ),
    );
    const provider = new MountainProjectProvider();
    const run = () =>
      provider.sync(
        new SyncRun({
          db: ctx.db,
          window: SyncWindow.full(new Date("2026-08-11T00:00:00.000Z")),
          userId,
        }),
      );
    await run();
    currentExport = fixtureCsv.split("\n")[0] ?? "";
    await expect(run()).resolves.toMatchObject({ recordsSynced: 0, errors: [] });
    let entries = await ctx.db.select().from(climbingEntry);
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.providerAbsentAt === null)).toBe(true);

    server.use(
      http.get(
        "https://www.mountainproject.com/user/110186720/ticks/tick-export",
        () => new HttpResponse("unavailable", { status: 503 }),
      ),
    );
    await expect(run()).resolves.toMatchObject({ errors: [expect.any(Object)] });
    entries = await ctx.db.select().from(climbingEntry);
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.providerAbsentAt === null)).toBe(true);
  });
});
