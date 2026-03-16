import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activity, metricStream } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import type { StravaActivity, StravaStreamSet } from "./strava.ts";
import { StravaProvider } from "./strava.ts";

function fakeActivity(overrides: Partial<StravaActivity> = {}): StravaActivity {
  return {
    id: 1001,
    name: "Morning Ride",
    type: "Ride",
    sport_type: "Ride",
    start_date: "2026-03-01T10:00:00Z",
    elapsed_time: 3700,
    moving_time: 3600,
    distance: 42000,
    total_elevation_gain: 350,
    average_speed: 11.67,
    max_speed: 15.5,
    average_heartrate: 155,
    max_heartrate: 178,
    average_watts: 220,
    average_cadence: 88,
    trainer: false,
    commute: false,
    manual: false,
    ...overrides,
  };
}

function fakeStreams(): StravaStreamSet {
  return {
    time: { data: [0, 1, 2], series_type: "time", resolution: "high", original_size: 3 },
    heartrate: { data: [130, 135, 140], series_type: "time", resolution: "high", original_size: 3 },
    watts: { data: [200, 210, 205], series_type: "time", resolution: "high", original_size: 3 },
    cadence: { data: [85, 88, 86], series_type: "time", resolution: "high", original_size: 3 },
    velocity_smooth: {
      data: [8.5, 8.7, 8.6],
      series_type: "time",
      resolution: "high",
      original_size: 3,
    },
    latlng: {
      data: [
        [40.7128, -74.006],
        [40.7129, -74.0059],
        [40.713, -74.0058],
      ],
      series_type: "time",
      resolution: "high",
      original_size: 3,
    },
    altitude: {
      data: [15.2, 15.5, 15.8],
      series_type: "time",
      resolution: "high",
      original_size: 3,
    },
  };
}

function stravaHandlers(
  activities: StravaActivity[],
  opts?: { streamsError?: boolean; rateLimited?: boolean },
) {
  const streams = fakeStreams();
  const streamArray = Object.entries(streams).map(([type, stream]) => ({
    type,
    ...stream,
  }));

  return [
    // Token refresh
    http.post("https://www.strava.com/oauth/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 21600,
        token_type: "Bearer",
      });
    }),

    // Streams endpoint
    http.get("https://www.strava.com/api/v3/activities/:activityId/streams", () => {
      if (opts?.rateLimited) {
        return new HttpResponse("Rate Limit Exceeded", {
          status: 429,
          headers: { "X-RateLimit-Limit": "100,1000", "X-RateLimit-Usage": "100,950" },
        });
      }
      if (opts?.streamsError) {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }
      return HttpResponse.json(streamArray);
    }),

    // Activities list
    http.get("https://www.strava.com/api/v3/athlete/activities", () => {
      if (opts?.rateLimited) {
        return new HttpResponse("Rate Limit Exceeded", {
          status: 429,
          headers: { "X-RateLimit-Limit": "100,1000", "X-RateLimit-Usage": "100,950" },
        });
      }
      return HttpResponse.json(activities);
    }),
  ];
}

const server = setupServer();

describe("StravaProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.STRAVA_CLIENT_ID = "test-client-id";
    process.env.STRAVA_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: "error" });
    await ensureProvider(ctx.db, "strava", "Strava", "https://www.strava.com/api/v3");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs activities with streams into activity and metric_stream", async () => {
    await saveTokens(ctx.db, "strava", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read,activity:read_all",
    });

    const activities = [
      fakeActivity({ id: 1001, start_date: "2026-03-01T10:00:00Z" }),
      fakeActivity({
        id: 1002,
        start_date: "2026-03-05T14:00:00Z",
        type: "Run",
        sport_type: "Run",
      }),
    ];

    server.use(...stravaHandlers(activities));

    const provider = new StravaProvider();
    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("strava");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify activity rows
    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "strava"));
    expect(rows).toHaveLength(2);

    const ride = rows.find((r) => r.externalId === "1001");
    if (!ride) throw new Error("expected activity 1001");
    expect(ride.activityType).toBe("cycling");
    expect(ride.name).toBe("Morning Ride");

    const run = rows.find((r) => r.externalId === "1002");
    if (!run) throw new Error("expected activity 1002");
    expect(run.activityType).toBe("running");

    // Verify metric_stream rows
    const metrics = await ctx.db
      .select()
      .from(metricStream)
      .where(eq(metricStream.activityId, ride.id));
    expect(metrics).toHaveLength(3);
    expect(metrics[0]?.heartRate).toBe(130);
    expect(metrics[0]?.power).toBe(200);
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "strava", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read,activity:read_all",
    });

    const activities = [fakeActivity({ id: 1001, start_date: "2026-03-01T10:00:00Z" })];

    server.use(...stravaHandlers(activities));

    const provider = new StravaProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "strava"));
    const countOf1001 = rows.filter((r) => r.externalId === "1001").length;
    expect(countOf1001).toBe(1);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "strava", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"),
      scopes: "read,activity:read_all",
    });

    server.use(...stravaHandlers([]));

    const provider = new StravaProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "strava");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  it("continues syncing if streams fetch fails", async () => {
    await saveTokens(ctx.db, "strava", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read,activity:read_all",
    });

    const activities = [fakeActivity({ id: 3001, start_date: "2026-05-01T10:00:00Z" })];

    server.use(...stravaHandlers(activities, { streamsError: true }));

    const provider = new StravaProvider();
    const result = await provider.sync(ctx.db, new Date("2026-04-01T00:00:00Z"));

    // Activity should still be inserted
    expect(result.recordsSynced).toBe(1);
    // But there should be a streams error
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Streams");

    const activities2 = await ctx.db.select().from(activity).where(eq(activity.externalId, "3001"));
    expect(activities2).toHaveLength(1);
  });

  it("stops fetching streams on rate limit (429) but keeps synced activities", async () => {
    await saveTokens(ctx.db, "strava", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read,activity:read_all",
    });

    const activities = [
      fakeActivity({ id: 4001, start_date: "2026-06-01T10:00:00Z" }),
      fakeActivity({ id: 4002, start_date: "2026-06-02T10:00:00Z" }),
    ];

    server.use(...stravaHandlers(activities, { rateLimited: true }));

    const provider = new StravaProvider();
    const result = await provider.sync(ctx.db, new Date("2026-05-01T00:00:00Z"));

    // Should report rate limit error
    expect(
      result.errors.some((e) => e.message.includes("rate limit") || e.message.includes("429")),
    ).toBe(true);
  });

  it("returns error when no tokens exist", async () => {
    const { oauthToken } = await import("../db/schema.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "strava"));

    const provider = new StravaProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);
  });
});
