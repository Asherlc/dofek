import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activity, sensorSample } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { type PelotonPerformanceGraph, PelotonProvider, type PelotonWorkout } from "./peloton.ts";

// ============================================================
// Fake Peloton API responses
// ============================================================

function fakeWorkout(overrides: Partial<PelotonWorkout> = {}): PelotonWorkout {
  return {
    id: "workout-001",
    status: "COMPLETE",
    fitness_discipline: "cycling",
    name: "Cycling Workout",
    title: "30 min Power Zone Ride",
    created_at: 1709280000,
    start_time: 1709280000, // 2024-03-01T08:00:00Z
    end_time: 1709281800,
    total_work: 360000,
    is_total_work_personal_record: false,
    ride: {
      id: "ride-001",
      title: "30 min Power Zone Ride",
      duration: 1800,
      difficulty_rating_avg: 7.85,
      overall_rating_avg: 4.9,
      instructor: { id: "instr-001", name: "Matt Wilpers" },
    },
    total_leaderboard_users: 15000,
    leaderboard_rank: 3200,
    average_effort_score: null,
    ...overrides,
  };
}

function fakePerformanceGraph(): PelotonPerformanceGraph {
  return {
    duration: 1800,
    is_class_plan_shown: true,
    segment_list: [],
    average_summaries: [],
    summaries: [
      { display_name: "Calories", value: "450", slug: "calories" },
      { display_name: "Distance", value: "9.25", slug: "distance" },
    ],
    metrics: [
      {
        display_name: "Heart Rate",
        slug: "heart_rate",
        values: [130, 145, 160],
        average_value: 145,
        max_value: 160,
      },
      {
        display_name: "Output",
        slug: "output",
        values: [180, 200, 220],
        average_value: 200,
        max_value: 220,
      },
      {
        display_name: "Cadence",
        slug: "cadence",
        values: [80, 85, 90],
        average_value: 85,
        max_value: 90,
      },
      {
        display_name: "Speed",
        slug: "speed",
        values: [17.0, 18.5, 20.0],
        average_value: 18.5,
        max_value: 20.0,
      },
    ],
  };
}

function pelotonHandlers(
  workouts: PelotonWorkout[],
  graph: PelotonPerformanceGraph = fakePerformanceGraph(),
) {
  return [
    // Token refresh (Auth0 domain, not API domain)
    http.post("https://auth.onepeloton.com/oauth/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 172800,
        scope: "offline_access openid peloton-api.members:default",
      });
    }),

    // Get user info
    http.get("https://api.onepeloton.com/api/me", () => {
      return HttpResponse.json({ id: "user-123" });
    }),

    // Performance graph
    http.get("https://api.onepeloton.com/api/workout/:workoutId/performance_graph", () => {
      return HttpResponse.json(graph);
    }),

    // Workout list
    http.get("https://api.onepeloton.com/api/user/:userId/workouts", () => {
      return HttpResponse.json({
        data: workouts,
        total: workouts.length,
        count: workouts.length,
        page: 0,
        limit: 20,
        page_count: 1,
        sort_by: "-created_at",
        show_next: false,
        show_previous: false,
      });
    }),
  ];
}

const server = setupServer();

// ============================================================
// Tests
// ============================================================

describe("PelotonProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, "peloton", "Peloton", "https://api.onepeloton.com");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs workouts with enriched stats into cardio_activity", async () => {
    // Seed valid tokens
    await saveTokens(ctx.db, "peloton", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "offline_access openid peloton-api.members:default",
    });

    const workouts = [
      fakeWorkout({ id: "workout-001", start_time: 1709280000, end_time: 1709281800 }),
      fakeWorkout({
        id: "workout-002",
        start_time: 1709366400,
        end_time: 1709368200,
        fitness_discipline: "running",
        ride: {
          id: "ride-002",
          title: "45 min Endurance Run",
          duration: 2700,
          difficulty_rating_avg: 8.2,
          instructor: { id: "instr-002", name: "Becs Gentry" },
        },
      }),
    ];

    server.use(...pelotonHandlers(workouts));

    const provider = new PelotonProvider();
    const since = new Date("2024-01-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("peloton");
    expect(result.errors).toHaveLength(0);

    // Verify cardio_activity rows
    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "peloton"));

    expect(rows).toHaveLength(2);

    const ride = rows.find((r) => r.externalId === "workout-001");
    if (!ride) throw new Error("expected workout-001");
    expect(ride.activityType).toBe("indoor_cycling");
    expect(ride.name).toBe("30 min Power Zone Ride");

    // Check raw JSONB metadata
    // ride.raw is typed as unknown (jsonb column); narrow via type guard
    const raw = ride.raw;
    if (raw === null || typeof raw !== "object") throw new Error("expected raw to be object");
    if ("instructor" in raw) expect(raw.instructor).toBe("Matt Wilpers");
    if ("classTitle" in raw) expect(raw.classTitle).toBe("30 min Power Zone Ride");
    if ("difficultyRating" in raw && typeof raw.difficultyRating === "number") {
      expect(raw.difficultyRating).toBeCloseTo(7.85);
    }

    const run = rows.find((r) => r.externalId === "workout-002");
    if (!run) throw new Error("expected workout-002");
    expect(run.activityType).toBe("running");
  });

  it("inserts sensor_sample rows from performance graph", async () => {
    const rows = await ctx.db
      .select()
      .from(sensorSample)
      .where(eq(sensorSample.providerId, "peloton"));

    // 2 workouts × 3 samples × 3 channels (heart_rate, power, cadence) = 18 rows
    expect(rows).toHaveLength(18);

    const workout1Start = new Date(1709280000 * 1000);
    const firstHeartRateRow = rows.find(
      (row) => row.channel === "heart_rate" && row.recordedAt.getTime() === workout1Start.getTime(),
    );
    if (!firstHeartRateRow) {
      throw new Error("expected heart-rate sensor sample at workout start time");
    }
    expect(firstHeartRateRow.scalar).toBe(130);
    const firstPowerRow = rows.find(
      (row) => row.channel === "power" && row.recordedAt.getTime() === workout1Start.getTime(),
    );
    if (!firstPowerRow) throw new Error("expected power sensor sample at workout start time");
    expect(firstPowerRow.scalar).toBe(180);
    const firstCadenceRow = rows.find(
      (row) => row.channel === "cadence" && row.recordedAt.getTime() === workout1Start.getTime(),
    );
    if (!firstCadenceRow) throw new Error("expected cadence sensor sample at workout start time");
    expect(firstCadenceRow.scalar).toBe(80);
  });

  it("upserts on re-sync (no duplicates)", async () => {
    const workouts = [
      fakeWorkout({ id: "workout-001", start_time: 1709280000, end_time: 1709281800 }),
    ];

    server.use(...pelotonHandlers(workouts));

    const provider = new PelotonProvider();
    await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "peloton"));

    const countOf001 = rows.filter((r) => r.externalId === "workout-001").length;
    expect(countOf001).toBe(1);
  });

  it("skips incomplete workouts", async () => {
    const workouts = [
      fakeWorkout({
        id: "workout-incomplete",
        status: "IN_PROGRESS",
        start_time: 1709452800,
        end_time: 0,
      }),
    ];

    server.use(...pelotonHandlers(workouts));

    const provider = new PelotonProvider();
    await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "workout-incomplete"));

    expect(rows).toHaveLength(0);
  });

  it("returns error when no tokens exist", async () => {
    const { oauthToken } = await import("../db/schema.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "peloton"));

    const provider = new PelotonProvider();
    const result = await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);

    // Restore tokens for other tests
    await saveTokens(ctx.db, "peloton", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "offline_access openid peloton-api.members:default",
    });
  });

  it("refreshes expired tokens before syncing", async () => {
    // Seed expired tokens
    await saveTokens(ctx.db, "peloton", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "offline_access openid peloton-api.members:default",
    });

    const workouts = [
      fakeWorkout({ id: "workout-refresh-test", start_time: 1709625600, end_time: 1709627400 }),
    ];

    server.use(...pelotonHandlers(workouts));

    const provider = new PelotonProvider();
    const result = await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    // Verify the activity was still synced despite token refresh
    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "workout-refresh-test"));
    expect(rows).toHaveLength(1);

    // Verify token was refreshed in DB
    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "peloton");
    expect(tokens?.accessToken).toBe("refreshed-token");

    // Restore valid tokens for other tests
    await saveTokens(ctx.db, "peloton", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "offline_access openid peloton-api.members:default",
    });
  });

  it("paginates through multiple pages of workouts", async () => {
    await saveTokens(ctx.db, "peloton", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "offline_access openid peloton-api.members:default",
    });

    let pageRequested = 0;

    server.use(
      http.get("https://api.onepeloton.com/api/me", () => {
        return HttpResponse.json({ id: "user-123" });
      }),
      http.get("https://api.onepeloton.com/api/workout/:workoutId/performance_graph", () => {
        return HttpResponse.json(fakePerformanceGraph());
      }),
      http.get("https://api.onepeloton.com/api/user/:userId/workouts", ({ request }) => {
        const url = new URL(request.url);
        const page = Number(url.searchParams.get("page") ?? "0");
        pageRequested = Math.max(pageRequested, page);

        if (page === 0) {
          return HttpResponse.json({
            data: [
              fakeWorkout({ id: "page0-workout", start_time: 1709712000, end_time: 1709713800 }),
            ],
            total: 2,
            count: 1,
            page: 0,
            limit: 1,
            page_count: 2,
            sort_by: "-created_at",
            show_next: true,
            show_previous: false,
          });
        }
        return HttpResponse.json({
          data: [
            fakeWorkout({ id: "page1-workout", start_time: 1709625600, end_time: 1709627400 }),
          ],
          total: 2,
          count: 1,
          page: 1,
          limit: 1,
          page_count: 2,
          sort_by: "-created_at",
          show_next: false,
          show_previous: true,
        });
      }),
    );

    const provider = new PelotonProvider();
    const result = await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);
    expect(pageRequested).toBeGreaterThanOrEqual(1);

    const page0 = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "page0-workout"));
    const page1 = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "page1-workout"));
    expect(page0).toHaveLength(1);
    expect(page1).toHaveLength(1);
  });

  it("continues syncing workouts even if performance graph fails", async () => {
    const workouts = [
      fakeWorkout({ id: "workout-graph-fail", start_time: 1709539200, end_time: 1709541000 }),
    ];

    server.use(
      http.get("https://api.onepeloton.com/api/me", () => {
        return HttpResponse.json({ id: "user-123" });
      }),
      http.get("https://api.onepeloton.com/api/workout/:workoutId/performance_graph", () => {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }),
      http.get("https://api.onepeloton.com/api/user/:userId/workouts", () => {
        return HttpResponse.json({
          data: workouts,
          total: 1,
          count: 1,
          page: 0,
          limit: 20,
          page_count: 1,
          sort_by: "-created_at",
          show_next: false,
          show_previous: false,
        });
      }),
    );

    const provider = new PelotonProvider();
    const result = await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Performance graph");

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "workout-graph-fail"));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.activityType).toBe("indoor_cycling");
  });

  it("stores timezone and stravaId on activity", async () => {
    const workouts = [
      fakeWorkout({
        id: "workout-tz",
        start_time: 1709625600,
        end_time: 1709627400,
        timezone: "America/New_York",
        strava_id: "9876543210",
      }),
    ];

    server.use(...pelotonHandlers(workouts));

    const provider = new PelotonProvider();
    await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.externalId, "workout-tz"));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.timezone).toBe("America/New_York");
    expect(rows[0]?.stravaId).toBe("9876543210");
  });

  it("nulls out power and cadence when has_pedaling_metrics is false", async () => {
    const workouts = [
      fakeWorkout({
        id: "workout-no-pedaling",
        start_time: 1709712000,
        end_time: 1709713800,
        has_pedaling_metrics: false,
      }),
    ];

    server.use(...pelotonHandlers(workouts));

    const provider = new PelotonProvider();
    await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    const activityId = (
      await ctx.db
        .select({ id: activity.id })
        .from(activity)
        .where(eq(activity.externalId, "workout-no-pedaling"))
    )[0]?.id;
    if (!activityId) throw new Error("expected workout-no-pedaling activity");

    const streams = await ctx.db
      .select()
      .from(sensorSample)
      .where(eq(sensorSample.activityId, activityId));

    expect(streams.length).toBeGreaterThan(0);
    const heartRateSamples = streams.filter((stream) => stream.channel === "heart_rate");
    const powerSamples = streams.filter((stream) => stream.channel === "power");
    const cadenceSamples = streams.filter((stream) => stream.channel === "cadence");
    expect(heartRateSamples.length).toBeGreaterThan(0);
    expect(heartRateSamples[0]?.scalar).toBe(130);
    // Power and cadence channels should be absent when pedaling metrics are disabled.
    expect(powerSamples).toHaveLength(0);
    expect(cadenceSamples).toHaveLength(0);
  });

  it("keeps power and cadence when has_pedaling_metrics is true", async () => {
    const workouts = [
      fakeWorkout({
        id: "workout-with-pedaling",
        start_time: 1709798400,
        end_time: 1709800200,
        has_pedaling_metrics: true,
      }),
    ];

    server.use(...pelotonHandlers(workouts));

    const provider = new PelotonProvider();
    await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    const activityId = (
      await ctx.db
        .select({ id: activity.id })
        .from(activity)
        .where(eq(activity.externalId, "workout-with-pedaling"))
    )[0]?.id;
    if (!activityId) throw new Error("expected workout-with-pedaling activity");

    const streams = await ctx.db
      .select()
      .from(sensorSample)
      .where(eq(sensorSample.activityId, activityId));

    expect(streams.length).toBeGreaterThan(0);
    const heartRateSamples = streams.filter((stream) => stream.channel === "heart_rate");
    const powerSamples = streams.filter((stream) => stream.channel === "power");
    const cadenceSamples = streams.filter((stream) => stream.channel === "cadence");
    expect(heartRateSamples[0]?.scalar).toBe(130);
    expect(powerSamples[0]?.scalar).toBe(180);
    expect(cadenceSamples[0]?.scalar).toBe(80);
  });
});
