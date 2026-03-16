import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { activity, oauthToken } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import { CyclingAnalyticsProvider } from "../cycling-analytics.ts";

// ============================================================
// Fake Cycling Analytics API responses
// ============================================================

interface FakeRideOverrides {
  id?: number;
  title?: string;
  date?: string;
  duration?: number;
  distance?: number;
  average_power?: number;
  normalized_power?: number;
  max_power?: number;
  average_heart_rate?: number;
  max_heart_rate?: number;
  average_cadence?: number;
  max_cadence?: number;
  elevation_gain?: number;
  elevation_loss?: number;
  average_speed?: number;
  max_speed?: number;
  calories?: number;
  training_stress_score?: number;
  intensity_factor?: number;
}

function fakeRide(overrides: FakeRideOverrides = {}) {
  return {
    id: 5001,
    title: "Morning Ride",
    date: "2026-03-01T08:00:00Z",
    duration: 3600,
    distance: 40000,
    average_power: 210,
    normalized_power: 225,
    max_power: 650,
    average_heart_rate: 148,
    max_heart_rate: 175,
    average_cadence: 90,
    max_cadence: 110,
    elevation_gain: 450,
    elevation_loss: 440,
    average_speed: 11.1,
    max_speed: 16.5,
    calories: 800,
    training_stress_score: 72,
    intensity_factor: 0.88,
    ...overrides,
  };
}

function cyclingAnalyticsHandlers(pages: Array<Array<ReturnType<typeof fakeRide>>>) {
  let pageIndex = 0;

  return [
    // Token refresh
    http.post("https://www.cyclinganalytics.com/api/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
      });
    }),

    // Rides list (paginated)
    http.get("https://www.cyclinganalytics.com/api/me/rides", () => {
      const rides = pages[pageIndex] ?? [];
      pageIndex++;
      return HttpResponse.json({ rides });
    }),
  ];
}

const server = setupServer();

describe("CyclingAnalyticsProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" });
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-client-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(
      ctx.db,
      "cycling_analytics",
      "Cycling Analytics",
      "https://www.cyclinganalytics.com/api",
    );
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs rides into activity table", async () => {
    await saveTokens(ctx.db, "cycling_analytics", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: null,
    });

    const rides = [
      fakeRide({ id: 5001, date: "2026-03-01T08:00:00Z", title: "Morning Ride" }),
      fakeRide({ id: 5002, date: "2026-03-05T14:00:00Z", title: "Afternoon Spin" }),
    ];

    server.use(...cyclingAnalyticsHandlers([rides]));

    const provider = new CyclingAnalyticsProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.provider).toBe("cycling_analytics");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "cycling_analytics"));

    expect(rows).toHaveLength(2);

    const ride1 = rows.find((r) => r.externalId === "5001");
    if (!ride1) throw new Error("expected ride 5001");
    expect(ride1.activityType).toBe("cycling");
    expect(ride1.name).toBe("Morning Ride");

    const ride2 = rows.find((r) => r.externalId === "5002");
    if (!ride2) throw new Error("expected ride 5002");
    expect(ride2.name).toBe("Afternoon Spin");
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "cycling_analytics", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: null,
    });

    const rides = [fakeRide({ id: 5001, date: "2026-03-01T08:00:00Z" })];

    server.use(...cyclingAnalyticsHandlers([rides]));

    const provider = new CyclingAnalyticsProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Sync again — should upsert, not duplicate
    server.resetHandlers();
    server.use(...cyclingAnalyticsHandlers([rides]));

    const provider2 = new CyclingAnalyticsProvider();
    await provider2.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "cycling_analytics"));

    const countOf5001 = rows.filter((r) => r.externalId === "5001").length;
    expect(countOf5001).toBe(1);
  });

  it("handles pagination across multiple pages", async () => {
    await saveTokens(ctx.db, "cycling_analytics", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: null,
    });

    const page1 = [
      fakeRide({ id: 6001, date: "2026-04-01T08:00:00Z" }),
      fakeRide({ id: 6002, date: "2026-04-02T08:00:00Z" }),
    ];
    const page2 = [fakeRide({ id: 6003, date: "2026-04-03T08:00:00Z" })];
    const page3: Array<ReturnType<typeof fakeRide>> = []; // empty page signals end

    server.use(...cyclingAnalyticsHandlers([page1, page2, page3]));

    const provider = new CyclingAnalyticsProvider();
    const result = await provider.sync(ctx.db, new Date("2026-03-15T00:00:00Z"));

    expect(result.recordsSynced).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "cycling_analytics", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: null,
    });

    server.use(...cyclingAnalyticsHandlers([[]]));

    const provider = new CyclingAnalyticsProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const { loadTokens } = await import("../../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "cycling_analytics");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "cycling_analytics"));

    const provider = new CyclingAnalyticsProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
    expect(result.recordsSynced).toBe(0);
  });
});
