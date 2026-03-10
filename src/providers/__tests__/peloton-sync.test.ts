import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.js";
import { activity, metricStream } from "../../db/schema.js";
import { ensureProvider, saveTokens } from "../../db/tokens.js";
import { type PelotonPerformanceGraph, PelotonProvider, type PelotonWorkout } from "../peloton.js";

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

function createMockFetch(
  workouts: PelotonWorkout[],
  graph: PelotonPerformanceGraph = fakePerformanceGraph(),
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = input.toString();

    // Token refresh
    if (urlStr.includes("/oauth/token")) {
      return Response.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 172800,
        scope: "offline_access openid peloton-api.members:default",
      });
    }

    // Get user info
    if (urlStr.includes("/api/me")) {
      return Response.json({ id: "user-123" });
    }

    // Performance graph
    if (urlStr.includes("/performance_graph")) {
      return Response.json(graph);
    }

    // Workout list
    if (urlStr.includes("/workouts")) {
      return Response.json({
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
    }

    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

// ============================================================
// Tests
// ============================================================

describe("PelotonProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "peloton", "Peloton", "https://api.onepeloton.com");
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
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

    const provider = new PelotonProvider(createMockFetch(workouts));
    const since = new Date("2024-01-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("peloton");
    expect(result.errors).toHaveLength(0);

    // Verify cardio_activity rows
    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "peloton"));

    expect(rows).toHaveLength(2);

    const ride = rows.find((r) => r.externalId === "workout-001")!;
    expect(ride.activityType).toBe("cycling");
    expect(ride.name).toBe("30 min Power Zone Ride");

    // Check raw JSONB metadata
    const raw = ride.raw as Record<string, unknown>;
    expect(raw.instructor).toBe("Matt Wilpers");
    expect(raw.classTitle).toBe("30 min Power Zone Ride");
    expect(raw.difficultyRating).toBeCloseTo(7.85);

    const run = rows.find((r) => r.externalId === "workout-002")!;
    expect(run.activityType).toBe("running");
  });

  it("inserts metric_stream rows from performance graph", async () => {
    const rows = await ctx.db
      .select()
      .from(metricStream)
      .where(eq(metricStream.providerId, "peloton"));

    // 2 workouts × 3 samples each = 6 rows
    expect(rows).toHaveLength(6);

    const workout1Start = new Date(1709280000 * 1000);
    const firstRow = rows.find((r) => r.recordedAt.getTime() === workout1Start.getTime())!;
    expect(firstRow.heartRate).toBe(130);
    expect(firstRow.power).toBe(180);
    expect(firstRow.cadence).toBe(80);
  });

  it("upserts on re-sync (no duplicates)", async () => {
    const workouts = [
      fakeWorkout({ id: "workout-001", start_time: 1709280000, end_time: 1709281800 }),
    ];

    const provider = new PelotonProvider(createMockFetch(workouts));
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

    const provider = new PelotonProvider(createMockFetch(workouts));
    await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "workout-incomplete"));

    expect(rows).toHaveLength(0);
  });

  it("returns error when no tokens exist", async () => {
    const { oauthToken } = await import("../../db/schema.js");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "peloton"));

    const provider = new PelotonProvider(createMockFetch([]));
    const result = await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);

    // Restore tokens for other tests
    await saveTokens(ctx.db, "peloton", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "offline_access openid peloton-api.members:default",
    });
  });

  it("continues syncing workouts even if performance graph fails", async () => {
    const workouts = [
      fakeWorkout({ id: "workout-graph-fail", start_time: 1709539200, end_time: 1709541000 }),
    ];

    const failGraphFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const urlStr = input.toString();
      if (urlStr.includes("/api/me")) {
        return Response.json({ id: "user-123" });
      }
      if (urlStr.includes("/performance_graph")) {
        return new Response("Internal Server Error", { status: 500 });
      }
      if (urlStr.includes("/workouts")) {
        return Response.json({
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
      }
      return new Response("Not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const provider = new PelotonProvider(failGraphFetch);
    const result = await provider.sync(ctx.db, new Date("2024-01-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("Performance graph");

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.externalId, "workout-graph-fail"));

    expect(rows).toHaveLength(1);
    expect(rows[0].activityType).toBe("cycling");
  });
});
