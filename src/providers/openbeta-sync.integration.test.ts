import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { climbingEntry } from "../db/schema/activity.ts";
import { TEST_USER_ID } from "../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { OpenBetaProvider } from "./openbeta.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

const OPENBETA_USER_UUID = "00000000-0000-0000-0000-000000000002";
const server = setupServer();

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

describe("OpenBetaProvider.sync() (integration)", () => {
  let ctx: TestContext;
  let currentTicks = [
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
  ];

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, "openbeta", "OpenBeta", "https://api.openbeta.io", TEST_USER_ID);
  }, 60_000);

  afterEach(() => {
    currentTicks = [tick(), tick({ _id: "tick-2", grade: "V4" })];
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("upserts ticks and reconciles absence without retiring empty exports", async () => {
    await saveTokens(
      ctx.db,
      "openbeta",
      {
        accessToken: OPENBETA_USER_UUID,
        refreshToken: null,
        expiresAt: new Date("2099-12-31T00:00:00.000Z"),
        scopes: "ticks",
      },
      TEST_USER_ID,
    );
    server.use(
      http.post("https://api.openbeta.io", () =>
        HttpResponse.json({ data: { userTicks: currentTicks } }),
      ),
    );

    const provider = new OpenBetaProvider();
    const run = () =>
      provider.sync(
        new SyncRun({
          db: ctx.db,
          window: SyncWindow.full(new Date("2026-08-11T00:00:00.000Z")),
          userId: TEST_USER_ID,
        }),
      );

    await expect(run()).resolves.toMatchObject({ recordsSynced: 2, errors: [] });
    await expect(run()).resolves.toMatchObject({ recordsSynced: 2, errors: [] });

    let entries = await ctx.db
      .select()
      .from(climbingEntry)
      .where(and(eq(climbingEntry.userId, TEST_USER_ID), eq(climbingEntry.providerId, "openbeta")));
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.externalId === "openbeta:tick-1")).toMatchObject({
      activityId: null,
      unattachedDate: "2026-08-10",
      raw: expect.objectContaining({ dateClimbed: 1786320000000 }),
      climbType: "route",
      gradeSystem: "yds",
      grade: "5.10a",
      sent: true,
      attemptCount: 1,
    });

    currentTicks = [tick()];
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    entries = await ctx.db
      .select()
      .from(climbingEntry)
      .where(and(eq(climbingEntry.userId, TEST_USER_ID), eq(climbingEntry.providerId, "openbeta")));
    expect(entries).toHaveLength(2);
    expect(
      entries.find((entry) => entry.externalId === "openbeta:tick-2")?.providerAbsentAt,
    ).toBeInstanceOf(Date);

    currentTicks = [];
    await expect(run()).resolves.toMatchObject({ recordsSynced: 0, errors: [] });
    entries = await ctx.db
      .select()
      .from(climbingEntry)
      .where(and(eq(climbingEntry.userId, TEST_USER_ID), eq(climbingEntry.providerId, "openbeta")));
    expect(
      entries.find((entry) => entry.externalId === "openbeta:tick-1")?.providerAbsentAt,
    ).toBeNull();
    expect(
      entries.find((entry) => entry.externalId === "openbeta:tick-2")?.providerAbsentAt,
    ).toBeInstanceOf(Date);

    currentTicks = [tick({ _id: "tick-2", grade: "V4" })];
    await expect(run()).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    entries = await ctx.db
      .select()
      .from(climbingEntry)
      .where(and(eq(climbingEntry.userId, TEST_USER_ID), eq(climbingEntry.providerId, "openbeta")));
    expect(
      entries.find((entry) => entry.externalId === "openbeta:tick-2")?.providerAbsentAt,
    ).toBeNull();
  });
});
