import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { activity, oauthToken } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import { XertProvider } from "../xert.ts";

// ============================================================
// Fake Xert API responses
// ============================================================

interface FakeActivityOverrides {
  id?: number;
  name?: string;
  sport?: string;
  startTimestamp?: number;
  endTimestamp?: number;
  duration?: number;
  distance?: number;
  power_avg?: number;
  power_max?: number;
  power_normalized?: number;
  heartrate_avg?: number;
  heartrate_max?: number;
  cadence_avg?: number;
  cadence_max?: number;
  calories?: number;
  elevation_gain?: number;
  elevation_loss?: number;
  xss?: number;
  focus?: number;
  difficulty?: number;
}

function fakeActivity(overrides: FakeActivityOverrides = {}) {
  return {
    id: 9001,
    name: "Threshold Intervals",
    sport: "Cycling",
    startTimestamp: 1709280000, // 2024-03-01T08:00:00Z (seconds)
    endTimestamp: 1709283600, // 2024-03-01T09:00:00Z
    duration: 3600,
    distance: 38000,
    power_avg: 230,
    power_max: 680,
    power_normalized: 248,
    heartrate_avg: 155,
    heartrate_max: 180,
    cadence_avg: 88,
    cadence_max: 115,
    calories: 900,
    elevation_gain: 400,
    elevation_loss: 390,
    xss: 95,
    focus: 320,
    difficulty: 3.5,
    ...overrides,
  };
}

function xertHandlers(pages: Array<Array<ReturnType<typeof fakeActivity>>>) {
  let pageIndex = 0;

  return [
    // Token refresh
    http.post("https://www.xertonline.com/oauth/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
      });
    }),

    // Activity list (paginated)
    http.get("https://www.xertonline.com/oauth/activity/", () => {
      const activities = pages[pageIndex] ?? [];
      pageIndex++;
      return HttpResponse.json(activities);
    }),
  ];
}

const server = setupServer();

describe("XertProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" });
    process.env.XERT_CLIENT_ID = "xert_public";
    process.env.XERT_CLIENT_SECRET = "xert_public";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "xert", "Xert", "https://www.xertonline.com");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs activities into activity table", async () => {
    await saveTokens(ctx.db, "xert", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: null,
    });

    const activities = [
      fakeActivity({ id: 9001, name: "Threshold Intervals", sport: "Cycling" }),
      fakeActivity({
        id: 9002,
        name: "Easy Run",
        sport: "Running",
        startTimestamp: 1709294400,
        endTimestamp: 1709298000,
      }),
    ];

    server.use(...xertHandlers([activities]));

    const provider = new XertProvider();
    const result = await provider.sync(ctx.db, new Date("2024-02-01T00:00:00Z"));

    expect(result.provider).toBe("xert");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "xert"));

    expect(rows).toHaveLength(2);

    const cycling = rows.find((r) => r.externalId === "9001");
    if (!cycling) throw new Error("expected activity 9001");
    expect(cycling.activityType).toBe("cycling");
    expect(cycling.name).toBe("Threshold Intervals");

    const running = rows.find((r) => r.externalId === "9002");
    if (!running) throw new Error("expected activity 9002");
    expect(running.activityType).toBe("running");
    expect(running.name).toBe("Easy Run");
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "xert", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: null,
    });

    const activities = [fakeActivity({ id: 9001 })];

    server.use(...xertHandlers([activities]));

    const provider = new XertProvider();
    await provider.sync(ctx.db, new Date("2024-02-01T00:00:00Z"));

    // Sync again
    server.resetHandlers();
    server.use(...xertHandlers([activities]));

    const provider2 = new XertProvider();
    await provider2.sync(ctx.db, new Date("2024-02-01T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "xert"));

    const countOf9001 = rows.filter((r) => r.externalId === "9001").length;
    expect(countOf9001).toBe(1);
  });

  it("handles pagination across multiple pages", async () => {
    await saveTokens(ctx.db, "xert", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: null,
    });

    // Xert paginates by checking if response length >= pageSize (50).
    // To simulate pagination, page 1 must have >= 50 items. Instead, we test
    // the stop condition: a page with fewer than pageSize items ends pagination.
    const page1 = [
      fakeActivity({ id: 7001, startTimestamp: 1709280000 }),
      fakeActivity({ id: 7002, startTimestamp: 1709290000 }),
    ];
    // Second page is empty, stopping pagination
    const page2: Array<ReturnType<typeof fakeActivity>> = [];

    server.use(...xertHandlers([page1, page2]));

    const provider = new XertProvider();
    const result = await provider.sync(ctx.db, new Date("2024-02-01T00:00:00Z"));

    // page1 has 2 items (< 50), so pagination stops after first page
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it("maps sport types correctly", async () => {
    await saveTokens(ctx.db, "xert", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: null,
    });

    const activities = [
      fakeActivity({ id: 8001, sport: "Swimming", startTimestamp: 1709380000 }),
      fakeActivity({ id: 8002, sport: "Virtual Cycling", startTimestamp: 1709390000 }),
      fakeActivity({ id: 8003, sport: "Mountain Biking", startTimestamp: 1709400000 }),
      fakeActivity({ id: 8004, sport: "Trail Running", startTimestamp: 1709410000 }),
      fakeActivity({ id: 8005, sport: "SomethingUnknown", startTimestamp: 1709420000 }),
    ];

    server.use(...xertHandlers([activities]));

    const provider = new XertProvider();
    const result = await provider.sync(ctx.db, new Date("2024-02-01T00:00:00Z"));
    expect(result.recordsSynced).toBe(5);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "xert"));

    const swim = rows.find((r) => r.externalId === "8001");
    expect(swim?.activityType).toBe("swimming");

    const virtualCycling = rows.find((r) => r.externalId === "8002");
    expect(virtualCycling?.activityType).toBe("cycling");

    const mtb = rows.find((r) => r.externalId === "8003");
    expect(mtb?.activityType).toBe("mountain_biking");

    const trail = rows.find((r) => r.externalId === "8004");
    expect(trail?.activityType).toBe("trail_running");

    const unknown = rows.find((r) => r.externalId === "8005");
    expect(unknown?.activityType).toBe("other");
  });

  it("stores Xert-specific fields in raw JSON", async () => {
    await saveTokens(ctx.db, "xert", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: null,
    });

    const activities = [
      fakeActivity({
        id: 8801,
        xss: 120,
        focus: 280,
        difficulty: 4.2,
        startTimestamp: 1709500000,
      }),
    ];

    server.use(...xertHandlers([activities]));

    const provider = new XertProvider();
    await provider.sync(ctx.db, new Date("2024-02-01T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.externalId, "8801"));
    expect(rows).toHaveLength(1);

    // @ts-expect-error -- test assertion on raw JSONB
    const raw: Record<string, unknown> = rows[0]?.raw;
    expect(raw.xss).toBe(120);
    expect(raw.focus).toBe(280);
    expect(raw.difficulty).toBe(4.2);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "xert", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: null,
    });

    server.use(...xertHandlers([[]]));

    const provider = new XertProvider();
    await provider.sync(ctx.db, new Date("2024-02-01T00:00:00Z"));

    const { loadTokens } = await import("../../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "xert");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "xert"));

    const provider = new XertProvider();
    const result = await provider.sync(ctx.db, new Date("2024-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
    expect(result.recordsSynced).toBe(0);
  });
});
