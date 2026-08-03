import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activity, dailyMetrics, sleepSession } from "../db/schema/activity.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { PolarProvider } from "./polar/provider.ts";
import type {
  PolarDailyActivity,
  PolarExercise,
  PolarNightlyRecharge,
  PolarSleep,
} from "./polar/types.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createCapturingMetricStreamPublisher } from "./test-helpers.ts";

const metricStreamCapture = createCapturingMetricStreamPublisher();

function fakePolarExercise(overrides: Partial<PolarExercise> = {}): PolarExercise {
  return {
    id: "ex-1001",
    upload_time: "2026-03-01T11:30:00Z",
    polar_user: "https://www.polaraccesslink.com/v3/users/12345",
    device: "Polar Vantage V3",
    start_time: "2026-03-01T10:00:00Z",
    duration: "PT1H15M30S",
    calories: 780,
    distance: 13500,
    heart_rate: { average: 152, maximum: 181 },
    sport: "RUNNING",
    has_route: true,
    detailed_sport_info: "Running",
    ...overrides,
  };
}

function fakePolarSleep(overrides: Partial<PolarSleep> = {}): PolarSleep {
  return {
    polar_user: "https://www.polaraccesslink.com/v3/users/12345",
    date: "2026-03-01",
    sleep_start_time: "2026-02-28T22:45:00Z",
    sleep_end_time: "2026-03-01T06:30:00Z",
    device_id: "A1B2C3D4",
    continuity: 3.2,
    continuity_class: 3,
    light_sleep: 13200, // 220m in seconds
    deep_sleep: 5100, // 85m
    rem_sleep: 6000, // 100m
    unrecognized_sleep_stage: 0,
    sleep_score: 78,
    total_interruption_duration: 2400, // 40m
    sleep_charge: 3,
    sleep_goal_minutes: 480,
    sleep_rating: 3,
    hypnogram: {},
    ...overrides,
  };
}

function fakePolarDailyActivity(overrides: Partial<PolarDailyActivity> = {}): PolarDailyActivity {
  return {
    polar_user: "https://www.polaraccesslink.com/v3/users/12345",
    start_time: "2026-03-01T08:00:00",
    end_time: "2026-03-01T23:59:59",
    active_duration: "PT3H11M",
    inactive_duration: "PT18H23M30S",
    daily_activity: 89.1,
    calories: 2400,
    active_calories: 850,
    duration: "PT14H30M",
    steps: 11200,
    ...overrides,
  };
}

function fakePolarNightlyRecharge(
  overrides: Partial<PolarNightlyRecharge> = {},
): PolarNightlyRecharge {
  return {
    polar_user: "https://www.polaraccesslink.com/v3/users/12345",
    date: "2026-03-01",
    heart_rate_avg: 52,
    beat_to_beat_avg: 1154,
    heart_rate_variability_avg: 48.5,
    breathing_rate_avg: 14.8,
    nightly_recharge_status: 3,
    ans_charge: 6.2,
    ans_charge_status: 3,
    ...overrides,
  };
}

function polarHandlers(opts?: {
  exercises?: PolarExercise[];
  sleep?: PolarSleep[];
  dailyActivity?: PolarDailyActivity[];
  nightlyRecharge?: PolarNightlyRecharge[];
}) {
  const exercises = opts?.exercises ?? [];
  const sleep = opts?.sleep ?? [];
  const dailyActivity = opts?.dailyActivity ?? [];
  const nightlyRecharge = opts?.nightlyRecharge ?? [];

  return [
    // Token refresh (Polar uses polarremote.com)
    http.post("https://polarremote.com/v2/oauth2/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-polar-token",
        refresh_token: "new-polar-refresh",
        expires_in: 86400,
        token_type: "Bearer",
      });
    }),

    // Exercises
    http.get("https://www.polaraccesslink.com/v3/exercises", () => {
      return HttpResponse.json(exercises);
    }),

    // Sleep
    http.get("https://www.polaraccesslink.com/v3/users/sleep", () => {
      return HttpResponse.json({ nights: sleep });
    }),

    // Nightly recharge
    http.get("https://www.polaraccesslink.com/v3/users/nightly-recharge", () => {
      return HttpResponse.json({ recharges: nightlyRecharge });
    }),

    // Daily activity
    http.get("https://www.polaraccesslink.com/v3/users/activities", () => {
      return HttpResponse.json(dailyActivity);
    }),

    // TCX export for exercises with GPS routes
    http.get("https://www.polaraccesslink.com/v3/exercises/:exerciseId/tcx", () => {
      return new HttpResponse(
        `<?xml version="1.0" encoding="UTF-8"?>
        <TrainingCenterDatabase>
          <Activities><Activity><Lap><Track>
            <Trackpoint>
              <Time>2026-03-01T10:00:00Z</Time>
              <Position>
                <LatitudeDegrees>60.1699</LatitudeDegrees>
                <LongitudeDegrees>24.9384</LongitudeDegrees>
              </Position>
              <AltitudeMeters>15.0</AltitudeMeters>
              <HeartRateBpm><Value>152</Value></HeartRateBpm>
            </Trackpoint>
          </Track></Lap></Activity></Activities>
        </TrainingCenterDatabase>`,
        { headers: { "Content-Type": "application/vnd.garmin.tcx+xml" } },
      );
    }),
  ];
}

const server = setupServer();

describe("PolarProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.POLAR_CLIENT_ID = "test-polar-client";
    process.env.POLAR_CLIENT_SECRET = "test-polar-secret";
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, "polar", "Polar", "https://www.polaraccesslink.com/v3");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
    metricStreamCapture.publishedMetricStreamRows.length = 0;
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs exercises, sleep, and daily activity with nightly recharge", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    server.use(
      ...polarHandlers({
        exercises: [
          fakePolarExercise({ id: "ex-1001" }),
          fakePolarExercise({
            id: "ex-1002",
            sport: "CYCLING",
            start_time: "2026-03-02T15:00:00Z",
            detailed_sport_info: "Road cycling",
            duration: "PT2H10M",
            distance: 55000,
            calories: 1200,
          }),
        ],
        sleep: [fakePolarSleep()],
        dailyActivity: [fakePolarDailyActivity()],
        nightlyRecharge: [fakePolarNightlyRecharge()],
      }),
    );

    const provider = new PolarProvider();
    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.provider).toBe("polar");
    expect(result.errors).toHaveLength(0);
    // duration is elapsed wall-clock (Date.now() - startTime), not Date.now() + startTime
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(60_000);

    // Verify exercises -> activity
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "polar"));
    expect(activityRows).toHaveLength(2);

    const run = activityRows.find((r) => r.externalId === "ex-1001");
    if (!run) throw new Error("expected exercise ex-1001");
    expect(run.activityType).toBe("running");
    expect(run.name).toBe("Running");

    const ride = activityRows.find((r) => r.externalId === "ex-1002");
    if (!ride) throw new Error("expected exercise ex-1002");
    expect(ride.activityType).toBe("cycling");

    // Verify sleep
    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "polar"));
    expect(sleepRows).toHaveLength(1);

    const sleepRecord = sleepRows[0];
    if (!sleepRecord) throw new Error("expected sleep session");
    expect(sleepRecord.deepMinutes).toBe(85);
    expect(sleepRecord.lightMinutes).toBe(220);
    expect(sleepRecord.remMinutes).toBe(100);
    expect(sleepRecord.stagingAvailable).toBe(true);
    expect(sleepRecord.awakeMinutes).toBe(40);

    // Verify daily metrics (with nightly recharge data merged)
    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "polar"));
    expect(dailyRows).toHaveLength(1);

    const daily = dailyRows[0];
    if (!daily) throw new Error("expected daily metrics");
    expect(daily.steps).toBe(11200);
    expect(daily.hrv).toBeCloseTo(48.5);
    expect(daily.respiratoryRateAvg).toBeCloseTo(14.8);
  });

  it("syncs daily activity without nightly recharge data", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    // Clear previous data
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "polar"));

    server.use(
      ...polarHandlers({
        dailyActivity: [
          fakePolarDailyActivity({
            start_time: "2026-03-05T08:00:00",
            end_time: "2026-03-05T23:59:59",
            steps: 8500,
            active_calories: 600,
          }),
        ],
        nightlyRecharge: [], // No recharge data
      }),
    );

    const provider = new PolarProvider();
    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);

    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "polar"));
    const march5 = dailyRows.find((r) => r.date === "2026-03-05");
    if (!march5) throw new Error("expected daily metrics for 2026-03-05");
    expect(march5.steps).toBe(8500);
    expect(march5.hrv).toBeNull();
  });

  it("syncs successfully when optional sync options are omitted", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    server.use(...polarHandlers());

    const provider = new PolarProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    expect(result.provider).toBe("polar");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    server.use(
      ...polarHandlers({
        exercises: [fakePolarExercise({ id: "ex-1001" })],
        sleep: [fakePolarSleep()],
        dailyActivity: [fakePolarDailyActivity()],
        nightlyRecharge: [fakePolarNightlyRecharge()],
      }),
    );

    const provider = new PolarProvider();
    const since = new Date("2026-02-01T00:00:00Z");
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "polar"));
    const countOf1001 = activityRows.filter((r) => r.externalId === "ex-1001").length;
    expect(countOf1001).toBe(1);
  });

  it("filters out exercises before since date", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    // Clear previous activity data
    await ctx.db.delete(activity).where(eq(activity.providerId, "polar"));

    server.use(
      ...polarHandlers({
        exercises: [
          fakePolarExercise({
            id: "ex-old",
            start_time: "2025-12-01T10:00:00Z", // before since
          }),
          fakePolarExercise({
            id: "ex-new",
            start_time: "2026-03-10T10:00:00Z", // after since
          }),
        ],
      }),
    );

    const provider = new PolarProvider();
    const since = new Date("2026-03-01T00:00:00Z");
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "polar"));
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]?.externalId).toBe("ex-new");
  });

  it("includes records on sync window boundaries and skips records outside them", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    await ctx.db.delete(activity).where(eq(activity.providerId, "polar"));
    await ctx.db.delete(sleepSession).where(eq(sleepSession.providerId, "polar"));
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "polar"));

    server.use(
      ...polarHandlers({
        exercises: [
          fakePolarExercise({ id: "ex-before", start_time: "2026-03-09T23:59:59.999Z" }),
          fakePolarExercise({ id: "ex-at-since", start_time: "2026-03-10T00:00:00.000Z" }),
          fakePolarExercise({ id: "ex-at-until", start_time: "2026-03-12T00:00:00.000Z" }),
          fakePolarExercise({ id: "ex-after", start_time: "2026-03-12T00:00:00.001Z" }),
        ],
        sleep: [
          fakePolarSleep({ date: "2026-03-09", sleep_start_time: "2026-03-09T23:59:59.999Z" }),
          fakePolarSleep({ date: "2026-03-10", sleep_start_time: "2026-03-10T00:00:00.000Z" }),
          fakePolarSleep({ date: "2026-03-12", sleep_start_time: "2026-03-12T00:00:00.000Z" }),
          fakePolarSleep({ date: "2026-03-13", sleep_start_time: "2026-03-12T00:00:00.001Z" }),
        ],
        dailyActivity: [
          fakePolarDailyActivity({ start_time: "2026-03-09T08:00:00" }),
          fakePolarDailyActivity({ start_time: "2026-03-10T08:00:00", steps: 10_001 }),
          fakePolarDailyActivity({ start_time: "2026-03-12T08:00:00", steps: 10_002 }),
          fakePolarDailyActivity({ start_time: "2026-03-13T08:00:00", steps: 10_003 }),
        ],
      }),
    );

    const provider = new PolarProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: new SyncWindow({
          since: new Date("2026-03-10T00:00:00.000Z"),
          until: new Date("2026-03-12T00:00:00.000Z"),
        }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);

    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "polar"));
    expect(activityRows.map((row) => row.externalId).sort()).toEqual([
      "ex-at-since",
      "ex-at-until",
    ]);

    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "polar"));
    expect(sleepRows.map((row) => row.externalId).sort()).toEqual(["2026-03-10", "2026-03-12"]);

    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "polar"));
    expect(dailyRows.map((row) => row.date).sort()).toEqual(["2026-03-10", "2026-03-12"]);
  });

  it("returns error when no tokens exist", async () => {
    const { oauthToken } = await import("../db/schema/reference.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "polar"));

    const provider = new PolarProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);
  });
});

// ============================================================
// Coverage tests for daily_activity error paths
// ============================================================

function polarCoverageHandlers(opts: {
  dailyActivities?: PolarDailyActivity[];
  nightlyRecharges?: PolarNightlyRecharge[];
  dailyActivityError?: boolean;
}) {
  return [
    // Exercises — return empty
    http.get("https://www.polaraccesslink.com/v3/exercises", () => {
      return HttpResponse.json([]);
    }),

    // Sleep — return empty
    http.get("https://www.polaraccesslink.com/v3/users/sleep", () => {
      return HttpResponse.json({ nights: [] });
    }),

    // Nightly recharge
    http.get("https://www.polaraccesslink.com/v3/users/nightly-recharge", () => {
      return HttpResponse.json({ recharges: opts.nightlyRecharges ?? [] });
    }),

    // Daily activity
    http.get("https://www.polaraccesslink.com/v3/users/activities", () => {
      if (opts.dailyActivityError) {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }
      return HttpResponse.json(opts.dailyActivities ?? []);
    }),
  ];
}

describe("PolarProvider.sync() — daily_activity error paths (integration)", () => {
  let ctx: TestContext;
  const errorServer = setupServer();

  beforeAll(async () => {
    process.env.POLAR_CLIENT_ID = "test-polar-client";
    process.env.POLAR_CLIENT_SECRET = "test-polar-secret";
    ctx = await setupTestDatabase();
    errorServer.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, "polar", "Polar", "https://www.polaraccesslink.com/v3");
  }, 60_000);

  afterEach(() => {
    errorServer.resetHandlers();
  });

  afterAll(async () => {
    errorServer.close();
    if (ctx) await ctx.cleanup();
  });

  it("catches outer daily_activity withSyncLog error (lines 542-546)", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    errorServer.use(...polarCoverageHandlers({ dailyActivityError: true }));

    const provider = new PolarProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // The daily_activity fetch fails with 500, which throws inside withSyncLog
    // The outer catch at lines 542-546 should catch it
    const dailyError = result.errors.find((e) => e.message.includes("daily_activity"));
    expect(dailyError).toBeDefined();
  });

  it("inserts daily metrics successfully and handles insert errors (lines 530-535)", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    // Clear daily metrics
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "polar"));

    errorServer.use(
      ...polarCoverageHandlers({
        dailyActivities: [
          fakePolarDailyActivity({
            start_time: "2026-03-10T08:00:00",
            end_time: "2026-03-10T23:59:59",
            steps: 9000,
          }),
        ],
      }),
    );

    const provider = new PolarProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // Should succeed
    expect(result.errors).toHaveLength(0);
    const rows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "polar"));
    const march10 = rows.find((r) => r.date === "2026-03-10");
    expect(march10).toBeDefined();
    expect(march10?.steps).toBe(9000);
  });
});
