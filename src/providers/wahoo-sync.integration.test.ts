import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activity, sensorSample } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import type { WahooWorkout } from "./wahoo/client.ts";
import { WahooProvider } from "./wahoo/provider.ts";

// Fake Wahoo API responses
function fakeWorkout(overrides: Partial<WahooWorkout> = {}): WahooWorkout {
  return {
    id: 1001,
    workout_type_id: 0,
    starts: "2026-03-01T10:00:00Z",
    created_at: "2026-03-01T10:00:00Z",
    updated_at: "2026-03-01T11:00:00Z",
    workout_summary: {
      id: 2001,
      distance_accum: 42000,
      duration_active_accum: 3600,
      duration_total_accum: 3700,
      calories_accum: 850,
      heart_rate_avg: 155,
      power_avg: 220,
      speed_avg: 11.67,
      cadence_avg: 88,
      ascent_accum: 500,
      power_bike_np_last: 235,
      power_bike_tss_last: 78.5,
      created_at: "2026-03-01T11:00:00Z",
      updated_at: "2026-03-01T11:00:00Z",
      file: { url: "https://cdn.wahoo.com/files/test.fit" },
    },
    ...overrides,
  };
}

// Load a real FIT fixture for testing
const FIT_FIXTURE_PATH = resolve(import.meta.dirname, "../fit/fixtures/test.fit");
const fitFileBuffer = readFileSync(FIT_FIXTURE_PATH);

function wahooHandlers(workouts: WahooWorkout[], opts?: { fitFileError?: boolean }) {
  return [
    // Token refresh
    http.post("https://api.wahooligan.com/oauth/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
        scope: "user_read workouts_read",
      });
    }),

    // FIT file download
    http.get("https://cdn.wahoo.com/files/*", () => {
      if (opts?.fitFileError) {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }
      return new HttpResponse(fitFileBuffer);
    }),

    // Workout list
    http.get("https://api.wahooligan.com/v1/workouts", () => {
      return HttpResponse.json({
        workouts,
        total: workouts.length,
        page: 1,
        per_page: 30,
        order: "descending",
        sort: "starts",
      });
    }),
  ];
}

const server = setupServer();

describe("WahooProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.WAHOO_CLIENT_ID = "test-client-id";
    process.env.WAHOO_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, "wahoo", "Wahoo", "https://api.wahooligan.com");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs workouts into cardio_activity", async () => {
    // Seed expired tokens so sync triggers a refresh
    await saveTokens(ctx.db, "wahoo", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "user_read workouts_read",
    });

    const workouts = [
      fakeWorkout({ id: 1001, starts: "2026-03-01T10:00:00Z" }),
      fakeWorkout({ id: 1002, starts: "2026-03-05T14:00:00Z", workout_type_id: 1 }),
    ];

    server.use(...wahooHandlers(workouts));

    const provider = new WahooProvider();
    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("wahoo");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify rows in DB
    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "wahoo"));

    expect(rows).toHaveLength(2);

    const ride = rows.find((r) => r.externalId === "1001");
    if (!ride) throw new Error("expected workout 1001");
    expect(ride.activityType).toBe("cycling");

    const run = rows.find((r) => r.externalId === "1002");
    if (!run) throw new Error("expected workout 1002");
    expect(run.activityType).toBe("running");
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "wahoo", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_read workouts_read",
    });

    const workouts = [fakeWorkout({ id: 1001, starts: "2026-03-01T10:00:00Z" })];

    server.use(...wahooHandlers(workouts));

    const provider = new WahooProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Sync again — should upsert, not duplicate
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "wahoo"));

    // Should have 2 from previous test + no new dupes for 1001
    const countOf1001 = rows.filter((r) => r.externalId === "1001").length;
    expect(countOf1001).toBe(1);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "wahoo", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"),
      scopes: "user_read workouts_read",
    });

    server.use(...wahooHandlers([]));

    const provider = new WahooProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Verify token was refreshed in DB
    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "wahoo");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  it("downloads FIT files and inserts sensor_sample records", async () => {
    await saveTokens(ctx.db, "wahoo", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_read workouts_read",
    });

    const workouts = [fakeWorkout({ id: 2001, starts: "2026-04-01T10:00:00Z" })];

    server.use(...wahooHandlers(workouts));

    const provider = new WahooProvider();
    const result = await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);

    // Verify sensor_sample rows linked to the cardio_activity
    const activities = await ctx.db.select().from(activity).where(eq(activity.externalId, "2001"));

    expect(activities).toHaveLength(1);
    const firstActivity = activities[0];
    if (!firstActivity) throw new Error("expected activity");
    const activityId = firstActivity.id;

    const metrics = await ctx.db
      .select()
      .from(sensorSample)
      .where(eq(sensorSample.activityId, activityId));

    // test.fit has 3229 source samples; sensor_sample count should be at least that many rows.
    expect(metrics.length).toBeGreaterThanOrEqual(3229);
    // Verify records have actual speed channel data from test.fit.
    const speedSamples = metrics.filter((sample) => sample.channel === "speed");
    expect(speedSamples.length).toBeGreaterThan(0);
    // All records should be linked to the activity
    expect(metrics.every((sample) => sample.activityId === activityId)).toBe(true);
  });

  it("continues syncing if FIT file download fails", async () => {
    await saveTokens(ctx.db, "wahoo", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_read workouts_read",
    });

    const workouts = [fakeWorkout({ id: 3001, starts: "2026-05-01T10:00:00Z" })];

    server.use(...wahooHandlers(workouts, { fitFileError: true }));

    const provider = new WahooProvider();
    const result = await provider.sync(ctx.db, new Date("2026-04-01T00:00:00Z"));

    // Activity should still be inserted
    expect(result.recordsSynced).toBe(1);
    // But there should be a FIT file error
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("FIT file");

    // Verify the cardio_activity was still created
    const activities = await ctx.db.select().from(activity).where(eq(activity.externalId, "3001"));
    expect(activities).toHaveLength(1);
  });

  it("returns error when no tokens exist", async () => {
    // Clear tokens by saving then deleting — or simpler, just test with
    // a provider that tries to sync without tokens.
    // Delete existing wahoo tokens first.
    const { oauthToken } = await import("../db/schema.ts");
    const { eq } = await import("drizzle-orm");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "wahoo"));

    const provider = new WahooProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);
  });
});
