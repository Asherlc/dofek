import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { userSettings } from "../db/schema/account.ts";
import { activity } from "../db/schema/activity.ts";
import { TEST_USER_ID } from "../db/schema/core.ts";
import { oauthToken } from "../db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { isEncryptedCredentialValue } from "../security/credential-encryption.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import {
  type RideWithGpsApiTrackPoint,
  type RideWithGpsApiTripDetail,
  RideWithGpsProvider,
  type RideWithGpsSyncItem,
  type RideWithGpsSyncResponse,
  type RideWithGpsTripListResponse,
} from "./ride-with-gps.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createCapturingMetricStreamPublisher } from "./test-helpers.ts";

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

function fakeTrackPoints(count: number, startTime: number): RideWithGpsApiTrackPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    x: -73.9857 + i * 0.001,
    y: 40.7484 + i * 0.001,
    d: i * 100,
    e: 10 + i * 0.5,
    t: startTime + i * 5,
    s: 10 + Math.sin(i) * 2,
    h: 140 + (i % 10),
    c: 85 + (i % 5),
    p: 200 + (i % 20),
  }));
}

function fakeTripDetail(
  id: number,
  overrides: Partial<RideWithGpsApiTripDetail> = {},
): RideWithGpsApiTripDetail {
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

function fakeTripListResponse(
  trips: RideWithGpsApiTripDetail[],
  page = 1,
  pageSize = 100,
): RideWithGpsTripListResponse {
  const pageStartIndex = (page - 1) * pageSize;
  const pageTrips = trips.slice(pageStartIndex, pageStartIndex + pageSize);
  return {
    trips: pageTrips,
    meta: {
      pagination: {
        record_count: trips.length,
        page_count: Math.ceil(trips.length / pageSize),
        page_size: pageSize,
        next_page_url: null,
      },
    },
  };
}

function rwgpsHandlers(
  syncResponse: RideWithGpsSyncResponse,
  trips: Map<number, RideWithGpsApiTripDetail>,
) {
  return [
    // Token refresh
    http.post("https://ridewithgps.com/oauth/token.json", () => {
      return HttpResponse.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
      });
    }),

    // Sync endpoint
    http.get("https://ridewithgps.com/api/v1/sync.json", () => {
      return HttpResponse.json(syncResponse);
    }),

    // Trip inventory endpoint
    http.get("https://ridewithgps.com/api/v1/trips.json", ({ request }) => {
      const url = new URL(request.url);
      const page = Number(url.searchParams.get("page") ?? "1");
      const pageSize = Number(url.searchParams.get("page_size") ?? "100");
      return HttpResponse.json(fakeTripListResponse([...trips.values()], page, pageSize));
    }),

    // Trip detail endpoint
    http.get("https://ridewithgps.com/api/v1/trips/:tripId.json", ({ params }) => {
      const tripId = Number(params.tripId);
      const trip = trips.get(tripId);
      if (trip) {
        return HttpResponse.json({ trip });
      }
      return new HttpResponse("Not found", { status: 404 });
    }),
  ];
}

const server = setupServer();
const metricStreamCapture = createCapturingMetricStreamPublisher();

// ============================================================
// Tests
// ============================================================

describe("RideWithGpsProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.RWGPS_CLIENT_ID = "test-client-id";
    process.env.RWGPS_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, "ride-with-gps", "RideWithGPS", "https://ridewithgps.com");
  }, 60_000);

  beforeEach(() => {
    metricStreamCapture.publishedMetricStreamRows.length = 0;
    metricStreamCapture.deletedMetricStreamScopes.length = 0;
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs trips into activity and Redpanda metric stream events", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    const syncResp = fakeSyncResponse([{ item_id: 5001 }, { item_id: 5002 }]);
    const trips = new Map<number, RideWithGpsApiTripDetail>();
    trips.set(5001, fakeTripDetail(5001));
    trips.set(
      5002,
      fakeTripDetail(5002, {
        name: "Afternoon Run",
        activity_type: "running",
        departed_at: "2026-03-01T14:00:00Z",
      }),
    );

    server.use(...rwgpsHandlers(syncResp, trips));

    const provider = new RideWithGpsProvider();
    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

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
    expect(ride.canonicalType).toBe("cycling");
    expect(ride.name).toBe("Morning Ride 5001");

    const run = rows.find((r) => r.externalId === "5002");
    if (!run) throw new Error("expected trip 5002");
    expect(run.canonicalType).toBe("running");

    // Verify metric stream events (10 track points per trip)
    const metrics = metricStreamCapture.publishedMetricStreamRows.filter(
      (row) => row.activityId === ride.id,
    );

    const heartRateSamples = metrics.filter((sample) => sample.channel === "heart_rate");
    const powerSamples = metrics.filter((sample) => sample.channel === "power");
    const cadenceSamples = metrics.filter((sample) => sample.channel === "cadence");
    const locationSamples = metrics.filter((sample) => sample.channel === "location");

    expect(heartRateSamples).toHaveLength(10);
    expect(powerSamples).toHaveLength(10);
    expect(cadenceSamples).toHaveLength(10);
    expect(locationSamples).toHaveLength(10);
    expect(locationSamples.every((sample) => sample.point !== null)).toBe(true);
  });

  it("syncs trips discovered by trips inventory even when sync feed has no items", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    const trip = fakeTripDetail(5101);
    const trips = new Map<number, RideWithGpsApiTripDetail>();
    trips.set(5101, trip);

    server.use(...rwgpsHandlers(fakeSyncResponse([]), trips));

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromIsoRange({
          sinceIso: "2026-03-01T00:00:00.000Z",
          untilIso: "2026-03-02T00:00:00.000Z",
        }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);

    const rows = await ctx.db.select().from(activity).where(eq(activity.externalId, "5101"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.canonicalType).toBe("cycling");
  });

  it("includes inventory trips exactly on sync window boundaries and excludes outside trips", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    const trips = new Map<number, RideWithGpsApiTripDetail>();
    trips.set(
      5501,
      fakeTripDetail(5501, {
        departed_at: "2026-05-01T00:00:00.000Z",
        track_points: [],
      }),
    );
    trips.set(
      5502,
      fakeTripDetail(5502, {
        departed_at: "2026-05-02T00:00:00.000Z",
        track_points: [],
      }),
    );
    trips.set(
      5503,
      fakeTripDetail(5503, {
        departed_at: "2026-04-30T23:59:59.000Z",
        track_points: [],
      }),
    );
    trips.set(
      5504,
      fakeTripDetail(5504, {
        departed_at: "2026-05-02T00:00:01.000Z",
        track_points: [],
      }),
    );

    server.use(...rwgpsHandlers(fakeSyncResponse([]), trips));

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromIsoRange({
          sinceIso: "2026-05-01T00:00:00.000Z",
          untilIso: "2026-05-02T00:00:00.000Z",
        }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(2);

    const rows = await ctx.db
      .select({ externalId: activity.externalId })
      .from(activity)
      .where(eq(activity.providerId, "ride-with-gps"));
    const syncedExternalIds = new Set(rows.map((row) => row.externalId));
    expect(syncedExternalIds.has("5501")).toBe(true);
    expect(syncedExternalIds.has("5502")).toBe(true);
    expect(syncedExternalIds.has("5503")).toBe(false);
    expect(syncedExternalIds.has("5504")).toBe(false);
  });

  it("requests every trips inventory page with the expected page parameters", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    const inventoryTrips = Array.from({ length: 101 }, (_, index) =>
      fakeTripDetail(5601 + index, { track_points: [] }),
    );
    const trips = new Map<number, RideWithGpsApiTripDetail>(
      inventoryTrips.map((trip) => [trip.id, trip]),
    );
    const requestedTripPages: number[] = [];

    server.use(
      http.get("https://ridewithgps.com/api/v1/sync.json", () => {
        return HttpResponse.json(fakeSyncResponse([]));
      }),
      http.get("https://ridewithgps.com/api/v1/trips.json", ({ request }) => {
        const url = new URL(request.url);
        const page = Number(url.searchParams.get("page") ?? "1");
        const pageSize = Number(url.searchParams.get("page_size") ?? "100");
        requestedTripPages.push(page);
        return HttpResponse.json(fakeTripListResponse(inventoryTrips, page, pageSize));
      }),
      http.get("https://ridewithgps.com/api/v1/trips/:tripId.json", ({ params }) => {
        const tripId = Number(params.tripId);
        const trip = trips.get(tripId);
        if (trip) return HttpResponse.json({ trip });
        return new HttpResponse("Not found", { status: 404 });
      }),
    );

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromIsoRange({
          sinceIso: "2026-03-01T00:00:00.000Z",
          untilIso: "2026-03-02T00:00:00.000Z",
        }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(101);
    expect(requestedTripPages).toEqual([1, 2]);
  });

  it("processes sync-feed updates outside the requested inventory window before advancing cursor", async () => {
    const userId = "00000000-0000-0000-0000-000000000001";
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    const historicalTrip = fakeTripDetail(5201, {
      name: "Corrected Historical Ride",
      departed_at: "2019-06-01T10:00:00Z",
      updated_at: "2026-03-01T11:00:00Z",
      track_points: [],
    });
    const trips = new Map<number, RideWithGpsApiTripDetail>();
    trips.set(5201, historicalTrip);

    server.use(...rwgpsHandlers(fakeSyncResponse([{ item_id: 5201 }]), trips));

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromIsoRange({
          sinceIso: "2026-03-01T00:00:00.000Z",
          untilIso: "2026-03-02T00:00:00.000Z",
        }),
        userId,
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);

    const activities = await ctx.db.select().from(activity).where(eq(activity.externalId, "5201"));
    expect(activities).toHaveLength(1);
    expect(activities[0]?.name).toBe("Corrected Historical Ride");

    const settings = await ctx.db
      .select()
      .from(userSettings)
      .where(and(eq(userSettings.userId, userId), eq(userSettings.key, "rwgps_sync_cursor")));
    expect(settings[0]?.value).toEqual({ cursor: "2026-03-01T12:00:00Z" });
  });

  it("reconciles missing in-window activities after a complete trip inventory scan", async () => {
    const userId = "00000000-0000-0000-0000-000000000001";
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    await ctx.db.insert(activity).values([
      {
        providerId: "ride-with-gps",
        userId,
        externalId: "5301",
        canonicalType: "cycling",
        providerType: "cycling",
        modality: null,
        startedAt: new Date("2026-04-01T08:00:00Z"),
        endedAt: new Date("2026-04-01T09:00:00Z"),
      },
      {
        providerId: "ride-with-gps",
        userId,
        externalId: "5302",
        canonicalType: "cycling",
        providerType: "cycling",
        modality: null,
        startedAt: new Date("2026-04-02T08:00:00Z"),
        endedAt: new Date("2026-04-02T09:00:00Z"),
      },
    ]);

    const trips = new Map<number, RideWithGpsApiTripDetail>();
    trips.set(
      5302,
      fakeTripDetail(5302, {
        departed_at: "2026-04-02T08:00:00Z",
        track_points: [],
      }),
    );

    server.use(...rwgpsHandlers(fakeSyncResponse([]), trips));

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromIsoRange({
          sinceIso: "2026-04-01T00:00:00.000Z",
          untilIso: "2026-04-03T00:00:00.000Z",
        }),
        userId,
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db
      .select({
        externalId: activity.externalId,
        providerAbsentAt: activity.providerAbsentAt,
      })
      .from(activity)
      .where(eq(activity.providerId, "ride-with-gps"));
    const missing = rows.find((row) => row.externalId === "5301");
    const present = rows.find((row) => row.externalId === "5302");
    expect(missing?.providerAbsentAt).toBeInstanceOf(Date);
    expect(present?.providerAbsentAt).toBeNull();
  });

  it("continues sync-feed updates when trip inventory fails", async () => {
    const userId = "00000000-0000-0000-0000-000000000001";
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    const syncResp = fakeSyncResponse([{ item_id: 5401 }]);
    const trip = fakeTripDetail(5401, { track_points: [] });

    server.use(
      http.get("https://ridewithgps.com/api/v1/sync.json", () => {
        return HttpResponse.json(syncResp);
      }),
      http.get("https://ridewithgps.com/api/v1/trips.json", () => {
        return new HttpResponse("Service Unavailable", { status: 503 });
      }),
      http.get("https://ridewithgps.com/api/v1/trips/:tripId.json", ({ params }) => {
        if (Number(params.tripId) === 5401) return HttpResponse.json({ trip });
        return new HttpResponse("Not found", { status: 404 });
      }),
    );

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromIsoRange({
          sinceIso: "2026-03-01T00:00:00.000Z",
          untilIso: "2026-03-02T00:00:00.000Z",
        }),
        userId,
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors[0]?.message).toContain("Trip inventory endpoint failed");

    const rows = await ctx.db.select().from(activity).where(eq(activity.externalId, "5401"));
    expect(rows).toHaveLength(1);
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    const syncResp = fakeSyncResponse([{ item_id: 5001 }]);
    const trips = new Map<number, RideWithGpsApiTripDetail>();
    trips.set(5001, fakeTripDetail(5001));

    server.use(...rwgpsHandlers(syncResp, trips));

    const provider = new RideWithGpsProvider();
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "ride-with-gps"));

    const countOf5001 = rows.filter((r) => r.externalId === "5001").length;
    expect(countOf5001).toBe(1);
  });

  it("handles deleted trips by marking activity provider-absent", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    // First, sync a trip so it exists
    const syncResp1 = fakeSyncResponse([{ item_id: 6001 }]);
    const trips = new Map<number, RideWithGpsApiTripDetail>();
    trips.set(6001, fakeTripDetail(6001));

    server.use(...rwgpsHandlers(syncResp1, trips));

    const provider1 = new RideWithGpsProvider();
    await provider1.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    // Now sync with deleted action
    server.resetHandlers();
    const deleteSyncResp = fakeSyncResponse([{ item_id: 6001, action: "deleted" }]);
    server.use(...rwgpsHandlers(deleteSyncResp, new Map()));

    const provider2 = new RideWithGpsProvider();
    await provider2.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    const rows = await ctx.db.select().from(activity).where(eq(activity.externalId, "6001"));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerAbsentAt).toBeInstanceOf(Date);
  });

  it("does not re-fetch a trip id deleted earlier in the same sync feed", async () => {
    await ctx.db.delete(activity).where(eq(activity.externalId, "5701"));

    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    const syncResp = fakeSyncResponse([
      { item_id: 5701, action: "deleted" },
      { item_id: 5701, action: "created" },
    ]);
    const deletedTrip = fakeTripDetail(5701, { track_points: [] });

    server.use(
      http.get("https://ridewithgps.com/api/v1/sync.json", () => {
        return HttpResponse.json(syncResp);
      }),
      http.get("https://ridewithgps.com/api/v1/trips.json", () => {
        return HttpResponse.json(fakeTripListResponse([]));
      }),
      http.get("https://ridewithgps.com/api/v1/trips/5701.json", () => {
        return HttpResponse.json({ trip: deletedTrip });
      }),
    );

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.externalId, "5701"));
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

    server.use(...rwgpsHandlers(syncResp, new Map()));

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // No trips synced since the only item was a route
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "ride-with-gps"));

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found for RideWithGPS");
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
    server.use(...rwgpsHandlers(syncResp, new Map()));

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("7001");
    expect(result.recordsSynced).toBe(0);
  });

  it("handles track points without timestamps", async () => {
    await saveTokens(
      ctx.db,
      "ride-with-gps",
      {
        accessToken: "valid-token",
        refreshToken: "valid-refresh",
        expiresAt: new Date("2027-01-01T00:00:00Z"),
        scopes: "user",
      },
      TEST_USER_ID,
    );

    // Trip with track points that have no timestamp
    const noTimestampTrip = fakeTripDetail(8001, {
      track_points: [
        { x: -73.98, y: 40.74, d: 0 },
        { x: -73.97, y: 40.75, d: 100 },
      ],
    });

    const syncResp = fakeSyncResponse([{ item_id: 8001 }]);
    const trips = new Map<number, RideWithGpsApiTripDetail>();
    trips.set(8001, noTimestampTrip);

    server.use(...rwgpsHandlers(syncResp, trips));

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        userId: TEST_USER_ID,
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Activity should exist but no metric stream events (no timestamps)
    const activities = await ctx.db.select().from(activity).where(eq(activity.externalId, "8001"));
    expect(activities).toHaveLength(1);

    const metrics = metricStreamCapture.publishedMetricStreamRows.filter(
      (row) => row.activityId === activities[0]?.id,
    );
    expect(metrics).toHaveLength(0);
    expect(metricStreamCapture.deletedMetricStreamScopes).toEqual([
      { activityId: activities[0]?.id, userId: TEST_USER_ID },
    ]);
  });

  it("replaces an empty track with the scoped user ID", async () => {
    await saveTokens(
      ctx.db,
      "ride-with-gps",
      {
        accessToken: "valid-token",
        refreshToken: "valid-refresh",
        expiresAt: new Date("2027-01-01T00:00:00Z"),
        scopes: "user",
      },
      TEST_USER_ID,
    );

    const trip = fakeTripDetail(8002, { track_points: [] });
    server.use(...rwgpsHandlers(fakeSyncResponse([{ item_id: 8002 }]), new Map([[8002, trip]])));

    const result = await new RideWithGpsProvider().sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        userId: TEST_USER_ID,
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    const activities = await ctx.db.select().from(activity).where(eq(activity.externalId, "8002"));
    expect(activities).toHaveLength(1);
    expect(metricStreamCapture.publishedMetricStreamRows).toHaveLength(0);
    expect(metricStreamCapture.deletedMetricStreamScopes).toEqual([
      { activityId: activities[0]?.id, userId: TEST_USER_ID },
    ]);
  });

  it("handles sync endpoint failure and returns early with error (lines 308-319)", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    server.use(
      http.get("https://ridewithgps.com/api/v1/sync.json", () => {
        return new HttpResponse("Service Unavailable", { status: 503 });
      }),
    );

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Sync endpoint failed");
  });

  it("handles deleted trip where activity does not exist (exercises delete path, lines 333-338)", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    // Sync response with a deleted trip that doesn't exist in the DB
    const syncResp: RideWithGpsSyncResponse = {
      items: [
        {
          item_type: "trip",
          item_id: 99999,
          action: "deleted",
          datetime: "2026-03-01T10:00:00Z",
        },
      ],
      meta: { rwgps_datetime: "2026-03-01T12:00:00Z" },
    };

    server.use(
      http.get("https://ridewithgps.com/api/v1/sync.json", () => {
        return HttpResponse.json(syncResp);
      }),
      http.get("https://ridewithgps.com/api/v1/trips.json", () => {
        return HttpResponse.json(fakeTripListResponse([]));
      }),
    );

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // Delete of non-existent trip should not error
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
  });

  it("refreshes expired token before syncing", async () => {
    // Store an expired token
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2020-01-01T00:00:00Z"), // expired
      scopes: "user",
    });

    const syncResp = fakeSyncResponse([{ item_id: 11001 }]);
    const trips = new Map<number, RideWithGpsApiTripDetail>();
    trips.set(11001, fakeTripDetail(11001));

    let tokenUsedForSync: string | null = null;
    server.use(
      // Token refresh endpoint
      http.post("https://ridewithgps.com/oauth/token.json", () => {
        return HttpResponse.json({
          access_token: "refreshed-token",
          refresh_token: "new-refresh",
          expires_in: 7200,
        });
      }),
      // Sync endpoint — capture the token used
      http.get("https://ridewithgps.com/api/v1/sync.json", ({ request }) => {
        tokenUsedForSync = request.headers.get("Authorization");
        return HttpResponse.json(syncResp);
      }),
      http.get("https://ridewithgps.com/api/v1/trips.json", () => {
        return HttpResponse.json(fakeTripListResponse([...trips.values()]));
      }),
      http.get("https://ridewithgps.com/api/v1/trips/:tripId.json", ({ params }) => {
        const tripId = Number(params.tripId);
        const trip = trips.get(tripId);
        if (trip) return HttpResponse.json({ trip });
        return new HttpResponse("Not found", { status: 404 });
      }),
    );

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);
    // The refreshed token should have been used for the sync API call
    expect(tokenUsedForSync).toBe("Bearer refreshed-token");

    // Verify the refreshed token was persisted to the database
    const rows = await ctx.db
      .select()
      .from(oauthToken)
      .where(eq(oauthToken.providerId, "ride-with-gps"));
    expect(rows[0]?.accessToken).not.toBe("refreshed-token");
    expect(rows[0]?.refreshToken).not.toBe("new-refresh");
    expect(isEncryptedCredentialValue(rows[0]?.accessToken ?? "")).toBe(true);
    expect(isEncryptedCredentialValue(rows[0]?.refreshToken ?? "")).toBe(true);
    const loadedTokens = await loadTokens(ctx.db, "ride-with-gps");
    expect(loadedTokens?.accessToken).toBe("refreshed-token");
    expect(loadedTokens?.refreshToken).toBe("new-refresh");
  });

  it("returns error when token is expired and no refresh token exists", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "expired-token",
      refreshToken: null,
      expiresAt: new Date("2020-01-01T00:00:00Z"), // expired
      scopes: "user",
    });

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("refresh");
    expect(result.recordsSynced).toBe(0);
  });

  it("handles removed trip action (delete branch, lines 325-339)", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    const syncResp: RideWithGpsSyncResponse = {
      items: [
        {
          item_type: "trip",
          item_id: 88888,
          action: "removed",
          datetime: "2026-03-01T10:00:00Z",
        },
      ],
      meta: { rwgps_datetime: "2026-03-01T12:00:00Z" },
    };

    server.use(
      http.get("https://ridewithgps.com/api/v1/sync.json", () => {
        return HttpResponse.json(syncResp);
      }),
      http.get("https://ridewithgps.com/api/v1/trips.json", () => {
        return HttpResponse.json(fakeTripListResponse([]));
      }),
    );

    const provider = new RideWithGpsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
  });
});

describe("RideWithGpsProvider.getUserIdentity()", () => {
  const originalEnv = { ...process.env };
  const identityServer = setupServer();

  beforeAll(() => {
    identityServer.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    identityServer.resetHandlers();
  });

  afterAll(() => {
    identityServer.close();
  });

  it("returns identity from user API", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";

    identityServer.use(
      http.get("https://ridewithgps.com/users/current.json", () => {
        return HttpResponse.json({
          user: { id: 555, email: "rider@rwgps.com", name: "Road Rider" },
        });
      }),
    );

    const provider = new RideWithGpsProvider();
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    const identity = await setup.getUserIdentity("test-token");
    expect(identity.providerAccountId).toBe("555");
    expect(identity.email).toBe("rider@rwgps.com");
    expect(identity.name).toBe("Road Rider");
  });

  it("throws on API error", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";

    identityServer.use(
      http.get("https://ridewithgps.com/users/current.json", () => {
        return new HttpResponse("Not Found", { status: 404 });
      }),
    );

    const provider = new RideWithGpsProvider();
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    await expect(setup.getUserIdentity("bad-token")).rejects.toThrow("RWGPS user API error (404)");
  });
});
