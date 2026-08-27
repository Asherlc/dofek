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
const removedBoulderRow = "Jim Hall Left";
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

  it("inserts, idempotently updates, and reconciles a removed crag-day session", async () => {
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

    const activities = await ctx.db
      .select()
      .from(activity)
      .where(and(eq(activity.providerId, "mountain-project"), eq(activity.userId, userId)));
    expect(activities).toHaveLength(2);
    const entries = await ctx.db.select().from(climbingEntry);
    expect(entries).toHaveLength(3);
    expect(entries.find((entry) => entry.routeName === "West Overhang")).toMatchObject({
      sent: true,
      attemptCount: 1,
      gradeSystem: "yds",
      grade: "5.7",
    });

    currentExport = fixtureCsv
      .split("\n")
      .filter((line) => !line.includes(removedBoulderRow))
      .join("\n");
    await expect(run()).resolves.toMatchObject({ recordsSynced: 2, errors: [] });

    const [removed] = await ctx.db
      .select({ providerAbsentAt: activity.providerAbsentAt })
      .from(activity)
      .where(
        and(
          eq(activity.providerId, "mountain-project"),
          eq(activity.userId, userId),
          eq(activity.name, "Mountain Project climbing at Colorado > Boulder > Flagstaff"),
        ),
      );
    expect(removed?.providerAbsentAt).toBeInstanceOf(Date);
  });
});
