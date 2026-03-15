import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { activity, metricStream, oauthToken } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import {
  RideWithGpsProvider,
  type RideWithGpsSyncItem,
  type RideWithGpsSyncResponse,
  type RideWithGpsTrackPoint,
  type RideWithGpsTripDetail,
} from "../ride-with-gps.ts";

// ============================================================
// Fake RideWithGPS API responses
// ============================================================

function fakeSyncResponse(
  items: Array<{ item_id: number; action?: RideWithGpsSyncItem["action"] }>,
  cursor = "2026-03-01T12:00:00Z",
): RideWithGpsSyncResponse {
  return {
    items: items.map((item) => ({
      item_type: "trip" as const,
      item_id: item.item_id,
      action: item.action ?? "created",
      datetime: "2026-03-01T10:00:00Z",
    })),
    meta: { rwgps_datetime: cursor },
  };
}

function fakeTrackPoints(count: number, startTime: number): RideWithGpsTrackPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    x: -73.9857 + i * 0.001,
    y: 40.7484 + i * 0.001,
    d: i * 100,
    e: 10 + i * 0.5,
    t: startTime + i * 5,
    s: 25 + Math.sin(i) * 5,
    h: 140 + (i % 10),
    c: 85 + (i % 5),
    p: 200 + (i % 20),
  }));
}

function fakeTripDetail(
  id: number,
  overrides: Partial<RideWithGpsTripDetail> = {},
): RideWithGpsTripDetail {
  const startTime = Math.floor(new Date("2026-03-01T10:00:00Z").getTime() / 1000);
  return {
    id,
    name: `Morning Ride ${id}`,
    description: "A nice ride",
    departed_at: "2026-03-01T10:00:00Z",
    activity_type: "cycling",
    distance: 42000,
    duration: 3600,
    moving_time: 3500,
    elevation_gain: 350,
    elevation_loss: 340,
    created_at: "2026-03-01T10:00:00Z",
    updated_at: "2026-03-01T11:00:00Z",
    track_points: fakeTrackPoints(10, startTime),
    ...overrides,
  };
}

function createMockFetch(
  syncResponse: RideWithGpsSyncResponse,
  trips: Map<number, RideWithGpsTripDetail>,
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = input.toString();

    // Sync endpoint
    if (urlStr.includes("/api/v1/sync.json")) {
      return Response.json(syncResponse);
    }

    // Trip detail endpoint
    const tripMatch = urlStr.match(/\/api\/v1\/trips\/(\d+)\.json/);
    if (tripMatch) {
      const tripId = Number(tripMatch[1]);
      const trip = trips.get(tripId);
      if (trip) {
        return Response.json({ trip });
      }
      return new Response("Not found", { status: 404 });
    }

    // Token refresh
    if (urlStr.includes("/oauth/token")) {
      return Response.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
      });
    }

    return new Response("Not found", { status: 404 });
  };
}

// ============================================================
// Tests
// ============================================================

describe("RideWithGpsProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.RWGPS_CLIENT_ID = "test-client-id";
    process.env.RWGPS_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "ride-with-gps", "RideWithGPS", "https://ridewithgps.com");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("syncs trips into activity and metric_stream", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    const syncResp = fakeSyncResponse([{ item_id: 5001 }, { item_id: 5002 }]);
    const trips = new Map<number, RideWithGpsTripDetail>();
    trips.set(5001, fakeTripDetail(5001));
    trips.set(
      5002,
      fakeTripDetail(5002, {
        name: "Afternoon Run",
        activity_type: "running",
        departed_at: "2026-03-01T14:00:00Z",
      }),
    );

    const provider = new RideWithGpsProvider(createMockFetch(syncResp, trips));
    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("ride-with-gps");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify activity rows
    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "ride-with-gps"));

    expect(rows).toHaveLength(2);

    const ride = rows.find((r) => r.externalId === "5001");
    if (!ride) throw new Error("expected trip 5001");
    expect(ride.activityType).toBe("cycling");
    expect(ride.name).toBe("Morning Ride 5001");

    const run = rows.find((r) => r.externalId === "5002");
    if (!run) throw new Error("expected trip 5002");
    expect(run.activityType).toBe("running");

    // Verify metric_stream rows (10 track points per trip)
    const metrics = await ctx.db
      .select()
      .from(metricStream)
      .where(eq(metricStream.activityId, ride.id));

    expect(metrics).toHaveLength(10);
    expect(metrics[0]?.heartRate).toBeDefined();
    expect(metrics[0]?.power).toBeDefined();
    expect(metrics[0]?.cadence).toBeDefined();
    expect(metrics[0]?.lat).toBeDefined();
    expect(metrics[0]?.lng).toBeDefined();
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    const syncResp = fakeSyncResponse([{ item_id: 5001 }]);
    const trips = new Map<number, RideWithGpsTripDetail>();
    trips.set(5001, fakeTripDetail(5001));

    const provider = new RideWithGpsProvider(createMockFetch(syncResp, trips));
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "ride-with-gps"));

    const countOf5001 = rows.filter((r) => r.externalId === "5001").length;
    expect(countOf5001).toBe(1);
  });

  it("handles deleted trips by removing activity", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    // First, sync a trip so it exists
    const syncResp1 = fakeSyncResponse([{ item_id: 6001 }]);
    const trips = new Map<number, RideWithGpsTripDetail>();
    trips.set(6001, fakeTripDetail(6001));

    const provider1 = new RideWithGpsProvider(createMockFetch(syncResp1, trips));
    await provider1.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Now sync with deleted action
    const deleteSyncResp = fakeSyncResponse([{ item_id: 6001, action: "deleted" }]);
    const provider2 = new RideWithGpsProvider(createMockFetch(deleteSyncResp, new Map()));
    await provider2.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.externalId, "6001"));

    expect(rows).toHaveLength(0);
  });

  it("skips route items (only processes trips)", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    const syncResp: RideWithGpsSyncResponse = {
      items: [
        {
          item_type: "route",
          item_id: 9001,
          action: "created",
          datetime: "2026-03-01T10:00:00Z",
        },
      ],
      meta: { rwgps_datetime: "2026-03-01T12:00:00Z" },
    };

    const provider = new RideWithGpsProvider(createMockFetch(syncResp, new Map()));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // No trips synced since the only item was a route
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "ride-with-gps"));

    const provider = new RideWithGpsProvider(createMockFetch(fakeSyncResponse([]), new Map()));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No RWGPS credentials found");
    expect(result.recordsSynced).toBe(0);
  });

  it("handles trip fetch failure gracefully", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    // Sync response references trip 7001 but trips map doesn't have it (404)
    const syncResp = fakeSyncResponse([{ item_id: 7001 }]);
    const provider = new RideWithGpsProvider(createMockFetch(syncResp, new Map()));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("7001");
    expect(result.recordsSynced).toBe(0);
  });

  it("handles track points without timestamps", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    // Trip with track points that have no timestamp
    const noTimestampTrip = fakeTripDetail(8001, {
      track_points: [
        { x: -73.98, y: 40.74, d: 0 },
        { x: -73.97, y: 40.75, d: 100 },
      ],
    });

    const syncResp = fakeSyncResponse([{ item_id: 8001 }]);
    const trips = new Map<number, RideWithGpsTripDetail>();
    trips.set(8001, noTimestampTrip);

    const provider = new RideWithGpsProvider(createMockFetch(syncResp, trips));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.recordsSynced).toBe(1);

    // Activity should exist but no metric_stream rows (no timestamps)
    const activities = await ctx.db.select().from(activity).where(eq(activity.externalId, "8001"));
    expect(activities).toHaveLength(1);

    const metrics = await ctx.db
      .select()
      .from(metricStream)
      .where(eq(metricStream.activityId, activities[0]?.id ?? ""));
    expect(metrics).toHaveLength(0);
  });
});
