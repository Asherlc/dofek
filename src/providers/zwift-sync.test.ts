import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activity, dailyMetrics, metricStream } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { ZwiftProvider } from "./zwift.ts";

// ============================================================
// Fake Zwift API data builders
// ============================================================

function fakeZwiftActivitySummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 100001,
    id_str: "100001",
    profileId: 42,
    name: "Watopia Hilly Route",
    startDate: "2026-03-01T10:00:00Z",
    endDate: "2026-03-01T11:00:00Z",
    distanceInMeters: 35000,
    avgHeartRate: 155,
    maxHeartRate: 182,
    avgWatts: 220,
    maxWatts: 480,
    avgCadenceInRotationsPerMinute: 88,
    avgSpeedInMetersPerSecond: 9.72,
    maxSpeedInMetersPerSecond: 14.1,
    totalElevationInMeters: 650,
    calories: 850,
    sport: "CYCLING",
    rideOnGiven: 5,
    activityRideOnCount: 12,
    ...overrides,
  };
}

function fakeZwiftActivityDetail(activityId: number, opts?: { hasFitnessData?: boolean }) {
  return {
    id: activityId,
    id_str: String(activityId),
    profileId: 42,
    name: "Watopia Hilly Route",
    startDate: "2026-03-01T10:00:00Z",
    endDate: "2026-03-01T11:00:00Z",
    distanceInMeters: 35000,
    avgHeartRate: 155,
    maxHeartRate: 182,
    avgWatts: 220,
    maxWatts: 480,
    avgCadenceInRotationsPerMinute: 88,
    avgSpeedInMetersPerSecond: 9.72,
    maxSpeedInMetersPerSecond: 14.1,
    totalElevationInMeters: 650,
    calories: 850,
    sport: "CYCLING",
    fitnessData:
      opts?.hasFitnessData !== false
        ? { fullDataUrl: "https://cdn.zwift.com/fitness/100001.json" }
        : undefined,
  };
}

function fakeZwiftFitnessData(sampleCount = 3) {
  return {
    powerInWatts: Array.from({ length: sampleCount }, (_, i) => 200 + i * 10),
    heartRate: Array.from({ length: sampleCount }, (_, i) => 140 + i),
    cadencePerMin: Array.from({ length: sampleCount }, () => 88),
    distanceInCm: Array.from({ length: sampleCount }, (_, i) => (i + 1) * 100000),
    speedInCmPerSec: Array.from({ length: sampleCount }, () => 972),
    altitudeInCm: Array.from({ length: sampleCount }, (_, i) => 5000 + i * 100),
    latlng: Array.from({ length: sampleCount }, () => [51.5, -0.1] as [number, number]),
    timeInSec: Array.from({ length: sampleCount }, (_, i) => i * 60),
  };
}

function fakeZwiftPowerCurve(overrides: Record<string, unknown> = {}) {
  return {
    zFtp: 260,
    zMap: 320,
    vo2Max: 52.3,
    efforts: [
      { duration: 5, watts: 800, timestamp: "2026-03-01T10:05:00Z" },
      { duration: 60, watts: 400, timestamp: "2026-03-01T10:10:00Z" },
      { duration: 1200, watts: 280, timestamp: "2026-03-01T10:30:00Z" },
    ],
    ...overrides,
  };
}

// JWT with sub claim for athleteId 42
const FAKE_JWT_PAYLOAD = Buffer.from(JSON.stringify({ sub: "42" })).toString("base64");
const FAKE_ACCESS_TOKEN = `header.${FAKE_JWT_PAYLOAD}.signature`;

// ============================================================
// Mock fetch factory
// ============================================================

interface ZwiftMockFetchOptions {
  activities?: ReturnType<typeof fakeZwiftActivitySummary>[];
  activityDetails?: Record<number, ReturnType<typeof fakeZwiftActivityDetail>>;
  fitnessData?: ReturnType<typeof fakeZwiftFitnessData> | null;
  powerCurve?: ReturnType<typeof fakeZwiftPowerCurve>;
  tokenRefreshError?: boolean;
  fitnessDataError?: boolean;
  activityDetailError?: boolean;
  /** Return fewer activities on second page to test pagination stop */
  paginateActivities?: boolean;
}

function createMockFetch(opts: ZwiftMockFetchOptions = {}): typeof globalThis.fetch {
  const activities = opts.activities ?? [];
  let pageRequestCount = 0;

  return (async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const urlStr = input.toString();

    // Token refresh (Zwift auth endpoint)
    if (urlStr.includes("secure.zwift.com") && urlStr.includes("token")) {
      if (opts.tokenRefreshError) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json({
        access_token: "refreshed-zwift-token",
        refresh_token: "new-zwift-refresh",
        expires_in: 7200,
        token_type: "Bearer",
      });
    }

    // Power curve
    if (urlStr.includes("/api/power-curve/power-profile")) {
      return Response.json(opts.powerCurve ?? fakeZwiftPowerCurve());
    }

    // Activity detail (fetchSnapshots)
    if (urlStr.match(/\/api\/activities\/(\d+)/)) {
      if (opts.activityDetailError) {
        return new Response("Internal Server Error", { status: 500 });
      }
      const idMatch = urlStr.match(/\/api\/activities\/(\d+)/);
      const activityId = Number(idMatch?.[1]);
      const detail = opts.activityDetails?.[activityId] ?? fakeZwiftActivityDetail(activityId);
      return Response.json(detail);
    }

    // Fitness data download
    if (urlStr.includes("cdn.zwift.com/fitness/") || urlStr.includes("fitness")) {
      if (opts.fitnessDataError) {
        return new Response("Internal Server Error", { status: 500 });
      }
      if (opts.fitnessData === null) {
        return Response.json({});
      }
      return Response.json(opts.fitnessData ?? fakeZwiftFitnessData());
    }

    // Activity list (paginated)
    if (urlStr.includes("/api/profiles/") && urlStr.includes("/activities")) {
      pageRequestCount++;
      if (opts.paginateActivities && pageRequestCount > 1) {
        // Empty second page to stop pagination
        return Response.json([]);
      }
      return Response.json(activities);
    }

    // OAuth consumer URL (for garmin-connect, but Zwift doesn't use it)
    // Profile endpoint
    if (urlStr.includes("/api/profiles/")) {
      return Response.json({
        id: 42,
        firstName: "Test",
        lastName: "User",
        ftp: 260,
        weight: 75000,
        height: 180,
      });
    }

    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

// ============================================================
// Tests
// ============================================================

describe("ZwiftProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "zwift", "Zwift", "https://us-or-rly101.zwift.com");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("syncs activities with fitness data streams and power curve", async () => {
    await saveTokens(ctx.db, "zwift", {
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "athleteId:42",
    });

    const activities = [
      fakeZwiftActivitySummary({ id: 100001, id_str: "100001", startDate: "2026-03-01T10:00:00Z" }),
      fakeZwiftActivitySummary({
        id: 100002,
        id_str: "100002",
        startDate: "2026-03-05T14:00:00Z",
        sport: "RUNNING",
        name: "Zwift Run",
      }),
    ];

    const provider = new ZwiftProvider(
      createMockFetch({
        activities,
        paginateActivities: true,
      }),
    );

    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("zwift");
    // 2 activities + 1 power curve record
    expect(result.recordsSynced).toBe(3);
    expect(result.errors).toHaveLength(0);

    // Verify activity rows
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "zwift"));
    expect(activityRows).toHaveLength(2);

    const ride = activityRows.find((r) => r.externalId === "100001");
    if (!ride) throw new Error("expected activity 100001");
    expect(ride.activityType).toBe("cycling");
    expect(ride.name).toBe("Watopia Hilly Route");

    const run = activityRows.find((r) => r.externalId === "100002");
    if (!run) throw new Error("expected activity 100002");
    expect(run.activityType).toBe("running");

    // Verify metric_stream rows were inserted from fitness data
    const metrics = await ctx.db
      .select()
      .from(metricStream)
      .where(eq(metricStream.providerId, "zwift"));
    // 2 activities x 3 samples each = 6
    expect(metrics.length).toBe(6);

    const withPower = metrics.filter((m) => m.power !== null);
    expect(withPower.length).toBeGreaterThan(0);

    // Verify power curve wrote daily metrics (vo2max)
    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "zwift"));
    expect(dailyRows).toHaveLength(1);
    const daily = dailyRows[0];
    if (!daily) throw new Error("expected daily metrics");
    expect(daily.vo2max).toBeCloseTo(52.3);
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "zwift", {
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "athleteId:42",
    });

    const activities = [
      fakeZwiftActivitySummary({ id: 100001, id_str: "100001", startDate: "2026-03-01T10:00:00Z" }),
    ];

    const provider = new ZwiftProvider(createMockFetch({ activities, paginateActivities: true }));

    const since = new Date("2026-02-01T00:00:00Z");
    await provider.sync(ctx.db, since);
    await provider.sync(ctx.db, since);

    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "zwift"));
    const countOf100001 = activityRows.filter((r) => r.externalId === "100001").length;
    expect(countOf100001).toBe(1);
  });

  it("refreshes expired tokens via Zwift auth endpoint", async () => {
    await saveTokens(ctx.db, "zwift", {
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "athleteId:42",
    });

    const provider = new ZwiftProvider(
      createMockFetch({ activities: [], paginateActivities: true }),
    );
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Verify token was refreshed in DB
    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "zwift");
    expect(tokens?.accessToken).toBe("refreshed-zwift-token");
  });

  it("returns error when no tokens exist", async () => {
    const { oauthToken } = await import("../db/schema.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "zwift"));

    const provider = new ZwiftProvider(createMockFetch());
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("not connected");
    expect(result.recordsSynced).toBe(0);
  });

  it("returns error when athlete ID is missing from scopes", async () => {
    await saveTokens(ctx.db, "zwift", {
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "", // no athleteId
    });

    const provider = new ZwiftProvider(createMockFetch());
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("athlete ID not found");
    expect(result.recordsSynced).toBe(0);
  });

  it("returns error when token is expired and no refresh token", async () => {
    await saveTokens(ctx.db, "zwift", {
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: null,
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "athleteId:42",
    });

    const provider = new ZwiftProvider(createMockFetch());
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("no refresh token");
    expect(result.recordsSynced).toBe(0);
  });

  it("continues syncing if fitness data download fails (non-fatal)", async () => {
    await saveTokens(ctx.db, "zwift", {
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "athleteId:42",
    });

    const activities = [
      fakeZwiftActivitySummary({
        id: 200001,
        id_str: "200001",
        startDate: "2026-04-01T10:00:00Z",
      }),
    ];

    const provider = new ZwiftProvider(
      createMockFetch({
        activities,
        fitnessDataError: true,
        paginateActivities: true,
      }),
    );

    const result = await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    // Activity should still be synced (counted)
    // power curve also synced = at least 1 from activities
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);
    // But there should be a stream error
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    const streamError = result.errors.find((e) => e.message.includes("streams"));
    expect(streamError).toBeDefined();

    // Verify the activity was still created
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "200001"));
    expect(activityRows).toHaveLength(1);
  });

  it("stops paginating activities when activity start is before since date", async () => {
    await saveTokens(ctx.db, "zwift", {
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "athleteId:42",
    });

    // Activity that's before the since date — should trigger done=true
    const activities = [
      fakeZwiftActivitySummary({
        id: 300001,
        id_str: "300001",
        startDate: "2026-03-10T10:00:00Z",
      }),
      fakeZwiftActivitySummary({
        id: 300002,
        id_str: "300002",
        startDate: "2025-01-01T10:00:00Z", // before since
      }),
    ];

    const provider = new ZwiftProvider(createMockFetch({ activities }));

    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    // Only the first activity should be synced
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "300001"));
    expect(activityRows).toHaveLength(1);

    // The old activity should NOT be present
    const oldActivity = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "300002"));
    expect(oldActivity).toHaveLength(0);

    expect(result.errors).toHaveLength(0);
  });

  it("skips power curve sync when no FTP or VO2max data", async () => {
    await saveTokens(ctx.db, "zwift", {
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "athleteId:42",
    });

    // Clear existing daily metrics from previous tests
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "zwift"));

    const provider = new ZwiftProvider(
      createMockFetch({
        activities: [],
        paginateActivities: true,
        powerCurve: { zFtp: 0, zMap: 0, vo2Max: 0, efforts: [] },
      }),
    );

    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // No activities, no power curve data → 0 records
    expect(result.recordsSynced).toBe(0);

    // No daily metrics should be inserted for power curve
    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "zwift"));
    expect(dailyRows).toHaveLength(0);
  });
});
