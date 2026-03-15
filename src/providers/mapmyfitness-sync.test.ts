import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activity, oauthToken } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { MapMyFitnessProvider } from "./mapmyfitness.ts";

// ============================================================
// Fake MapMyFitness API responses
// ============================================================

interface FakeWorkoutOverrides {
  id?: string;
  name?: string;
  start_datetime?: string;
  activity_type?: string;
  distance_total?: number;
  active_time_total?: number;
  speed_avg?: number;
  speed_max?: number;
  metabolic_energy_total?: number;
  heart_rate_avg?: number;
  heart_rate_max?: number;
  cadence_avg?: number;
  power_avg?: number;
  power_max?: number;
}

function fakeWorkout(overrides: FakeWorkoutOverrides = {}) {
  const id = overrides.id ?? "mmf-1001";
  return {
    _links: { self: [{ id }] },
    name: overrides.name ?? "Morning Run",
    start_datetime: overrides.start_datetime ?? "2026-03-01T07:00:00+00:00",
    start_locale_timezone: "America/New_York",
    activity_type: overrides.activity_type ?? "Run",
    aggregates: {
      distance_total: overrides.distance_total ?? 8000,
      active_time_total: overrides.active_time_total ?? 2400,
      speed_avg: overrides.speed_avg ?? 3.33,
      speed_max: overrides.speed_max ?? 4.2,
      metabolic_energy_total: overrides.metabolic_energy_total ?? 2092000, // ~500 kcal
      heart_rate_avg: overrides.heart_rate_avg ?? 155,
      heart_rate_max: overrides.heart_rate_max ?? 178,
      cadence_avg: overrides.cadence_avg ?? 170,
      power_avg: overrides.power_avg,
      power_max: overrides.power_max,
    },
  };
}

interface MockFetchOptions {
  pages?: Array<{
    workouts: Array<ReturnType<typeof fakeWorkout>>;
    hasNext: boolean;
  }>;
}

function createMockFetch(opts: MockFetchOptions): typeof globalThis.fetch {
  const pages = opts.pages ?? [];
  let pageIndex = 0;

  return (async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const urlStr = input.toString();

    // Token refresh
    if (urlStr.includes("/oauth2/access_token")) {
      return Response.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
      });
    }

    // Workouts list (paginated via offset)
    if (urlStr.includes("/v7.1/workout/")) {
      const page = pages[pageIndex];
      pageIndex++;
      if (!page) {
        return Response.json({
          _embedded: { workouts: [] },
          _links: {},
          total_count: 0,
        });
      }
      return Response.json({
        _embedded: { workouts: page.workouts },
        _links: {
          next: page.hasNext ? [{ href: "/v7.1/workout/?offset=40" }] : undefined,
        },
        total_count: page.workouts.length,
      });
    }

    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("MapMyFitnessProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.MAPMYFITNESS_CLIENT_ID = "test-client-id";
    process.env.MAPMYFITNESS_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "mapmyfitness", "MapMyFitness", "https://api.mapmyfitness.com");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("syncs workouts into activity table", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    const workouts = [
      fakeWorkout({ id: "mmf-1001", name: "Morning Run", activity_type: "Run" }),
      fakeWorkout({
        id: "mmf-1002",
        name: "Bike to Work",
        activity_type: "Bike Ride",
        start_datetime: "2026-03-05T08:30:00+00:00",
      }),
    ];

    const provider = new MapMyFitnessProvider(
      createMockFetch({ pages: [{ workouts, hasNext: false }] }),
    );
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.provider).toBe("mapmyfitness");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "mapmyfitness"));

    expect(rows).toHaveLength(2);

    const run = rows.find((r) => r.externalId === "mmf-1001");
    if (!run) throw new Error("expected workout mmf-1001");
    expect(run.activityType).toBe("running");
    expect(run.name).toBe("Morning Run");

    const bike = rows.find((r) => r.externalId === "mmf-1002");
    if (!bike) throw new Error("expected workout mmf-1002");
    expect(bike.activityType).toBe("cycling");
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    const workouts = [fakeWorkout({ id: "mmf-1001" })];

    const provider = new MapMyFitnessProvider(
      createMockFetch({ pages: [{ workouts, hasNext: false }] }),
    );
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Sync again
    const provider2 = new MapMyFitnessProvider(
      createMockFetch({ pages: [{ workouts, hasNext: false }] }),
    );
    await provider2.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "mapmyfitness"));

    const countOf1001 = rows.filter((r) => r.externalId === "mmf-1001").length;
    expect(countOf1001).toBe(1);
  });

  it("handles pagination with next links", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    const page1Workouts = [
      fakeWorkout({ id: "mmf-p1", start_datetime: "2026-04-01T08:00:00+00:00" }),
      fakeWorkout({ id: "mmf-p2", start_datetime: "2026-04-02T08:00:00+00:00" }),
    ];
    const page2Workouts = [
      fakeWorkout({ id: "mmf-p3", start_datetime: "2026-04-03T08:00:00+00:00" }),
    ];

    const provider = new MapMyFitnessProvider(
      createMockFetch({
        pages: [
          { workouts: page1Workouts, hasNext: true },
          { workouts: page2Workouts, hasNext: false },
        ],
      }),
    );
    const result = await provider.sync(ctx.db, new Date("2026-03-15T00:00:00Z"));

    expect(result.recordsSynced).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  it("maps activity types correctly", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    const workouts = [
      fakeWorkout({
        id: "mmf-walk",
        activity_type: "Walk",
        start_datetime: "2026-05-01T08:00:00+00:00",
      }),
      fakeWorkout({
        id: "mmf-swim",
        activity_type: "Swim",
        start_datetime: "2026-05-02T08:00:00+00:00",
      }),
      fakeWorkout({
        id: "mmf-hike",
        activity_type: "Hike",
        start_datetime: "2026-05-03T08:00:00+00:00",
      }),
      fakeWorkout({
        id: "mmf-yoga",
        activity_type: "Yoga",
        start_datetime: "2026-05-04T08:00:00+00:00",
      }),
    ];

    const provider = new MapMyFitnessProvider(
      createMockFetch({ pages: [{ workouts, hasNext: false }] }),
    );
    const result = await provider.sync(ctx.db, new Date("2026-04-01T00:00:00Z"));
    expect(result.recordsSynced).toBe(4);

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "mapmyfitness"));

    const walk = rows.find((r) => r.externalId === "mmf-walk");
    expect(walk?.activityType).toBe("walking");

    const swim = rows.find((r) => r.externalId === "mmf-swim");
    expect(swim?.activityType).toBe("swimming");

    const hike = rows.find((r) => r.externalId === "mmf-hike");
    expect(hike?.activityType).toBe("hiking");

    const yoga = rows.find((r) => r.externalId === "mmf-yoga");
    expect(yoga?.activityType).toBe("yoga");
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "user_id:12345",
    });

    const provider = new MapMyFitnessProvider(
      createMockFetch({ pages: [{ workouts: [], hasNext: false }] }),
    );
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "mapmyfitness");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "mapmyfitness"));

    const provider = new MapMyFitnessProvider(createMockFetch({ pages: [] }));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
    expect(result.recordsSynced).toBe(0);
  });
});
