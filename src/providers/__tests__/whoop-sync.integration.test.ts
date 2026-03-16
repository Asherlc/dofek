import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { activity, dailyMetrics, metricStream, sleepSession } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import {
  type WhoopHrValue,
  WhoopProvider,
  type WhoopRecoveryRecord,
  type WhoopSleepRecord,
  type WhoopWorkoutRecord,
} from "../whoop.ts";

// ============================================================
// Fake WHOOP internal API cycle response
// The BFF endpoint returns cycles with recovery, sleep, and
// workouts embedded in each cycle object.
// ============================================================

interface FakeCycle {
  id?: number;
  user_id?: number;
  days: string[];
  recovery?: WhoopRecoveryRecord;
  sleep?: { id: number };
  workouts?: WhoopWorkoutRecord[];
  strain?: {
    workouts: WhoopWorkoutRecord[];
  };
}

function fakeCycle(overrides: Partial<FakeCycle> = {}): FakeCycle {
  return {
    id: 100,
    user_id: 10129,
    days: ["2026-03-01"],
    recovery: {
      cycle_id: 100,
      sleep_id: 10235,
      user_id: 10129,
      created_at: "2026-03-01T11:25:44.774Z",
      updated_at: "2026-03-01T14:25:44.774Z",
      score_state: "SCORED",
      score: {
        user_calibrating: false,
        recovery_score: 78,
        resting_heart_rate: 52,
        hrv_rmssd_milli: 65.5,
        spo2_percentage: 97.2,
        skin_temp_celsius: 33.7,
      },
    },
    sleep: { id: 10235 },
    workouts: [
      {
        activity_id: "abc12345-6789-0def-1234-567890abcdef",
        during: "['2026-03-01T10:00:00Z','2026-03-01T11:00:00Z')",
        timezone_offset: "-05:00",
        sport_id: 0, // running
        average_heart_rate: 155,
        max_heart_rate: 185,
        kilojoules: 2500.5,
        percent_recorded: 100,
        score: 12.5,
      },
    ],
    ...overrides,
  };
}

const fakeSleepResponse: WhoopSleepRecord = {
  id: 10235,
  user_id: 10129,
  created_at: "2026-03-01T06:00:00Z",
  updated_at: "2026-03-01T06:30:00Z",
  start: "2026-02-28T23:00:00Z",
  end: "2026-03-01T06:30:00Z",
  timezone_offset: "-05:00",
  nap: false,
  score_state: "SCORED",
  score: {
    stage_summary: {
      total_in_bed_time_milli: 27000000,
      total_awake_time_milli: 1800000,
      total_no_data_time_milli: 0,
      total_light_sleep_time_milli: 10800000,
      total_slow_wave_sleep_time_milli: 7200000,
      total_rem_sleep_time_milli: 5400000,
      sleep_cycle_count: 4,
      disturbance_count: 2,
    },
    sleep_needed: {
      baseline_milli: 28800000,
      need_from_sleep_debt_milli: 1800000,
      need_from_recent_strain_milli: 900000,
      need_from_recent_nap_milli: 0,
    },
    respiratory_rate: 16.1,
    sleep_performance_percentage: 92,
    sleep_consistency_percentage: 88,
    sleep_efficiency_percentage: 91.7,
  },
};

function fakeHrValues(count: number, startTime: number): WhoopHrValue[] {
  return Array.from({ length: count }, (_, i) => ({
    time: startTime + i * 6000, // 6s intervals
    data: 60 + Math.floor(Math.random() * 40),
  }));
}

function whoopHandlers(
  cycles: FakeCycle[],
  opts?: { hrValues?: WhoopHrValue[]; authError?: boolean },
) {
  return [
    // Cognito v3 auth endpoint (token refresh via REFRESH_TOKEN_AUTH)
    http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
      if (opts?.authError) {
        return HttpResponse.json(
          { __type: "NotAuthorizedException", message: "Invalid refresh token" },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        AuthenticationResult: {
          AccessToken: "test-token",
          RefreshToken: "test-refresh",
        },
      });
    }),

    // User bootstrap endpoint (for getting userId after auth)
    http.get("https://api.prod.whoop.com/users-service/v2/bootstrap/", () => {
      return HttpResponse.json({ id: 10129 });
    }),

    // Cycles (BFF endpoint)
    http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
      return HttpResponse.json({ records: cycles });
    }),

    // Weightlifting-service — return 404 unless overridden
    http.get(
      "https://api.prod.whoop.com/weightlifting-service/v2/weightlifting-workout/:activityId",
      () => {
        return new HttpResponse("Not found", { status: 404 });
      },
    ),

    // Sleep events
    http.get("https://api.prod.whoop.com/sleep-service/v1/sleep-events", () => {
      return HttpResponse.json(fakeSleepResponse);
    }),

    // Heart rate (metrics-service)
    http.get("https://api.prod.whoop.com/metrics-service/v1/metrics/user/:userId", () => {
      const values = opts?.hrValues ?? fakeHrValues(100, Date.now() - 600000);
      return HttpResponse.json({ values });
    }),

    // Journal / behavior-impact-service
    http.get("https://api.prod.whoop.com/behavior-impact-service/v1/impact", () => {
      return HttpResponse.json([]);
    }),
  ];
}

const server = setupServer();

describe("WhoopProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" });
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "whoop", "WHOOP");
    // Store a fake refresh token so the provider can authenticate
    await saveTokens(ctx.db, "whoop", {
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      scopes: "",
    });
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs recovery into daily_metrics with spo2 and skin temp", async () => {
    const cycles = [fakeCycle()];
    server.use(...whoopHandlers(cycles));
    const provider = new WhoopProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "whoop"));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const day = rows.find((r) => r.date === "2026-03-01");
    if (!day) throw new Error("expected day 2026-03-01");
    expect(day.restingHr).toBe(52);
    expect(day.hrv).toBeCloseTo(65.5);
    expect(day.spo2Avg).toBeCloseTo(97.2);
    expect(day.skinTempC).toBeCloseTo(33.7);
  });

  it("syncs sleep sessions", async () => {
    const cycles = [fakeCycle()];
    server.use(...whoopHandlers(cycles));
    const provider = new WhoopProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const rows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "whoop"));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const session = rows.find((r) => r.externalId === "10235");
    if (!session) throw new Error("expected session 10235");
    expect(session.deepMinutes).toBe(120);
    expect(session.remMinutes).toBe(90);
    expect(session.efficiencyPct).toBeCloseTo(91.7);
    expect(session.isNap).toBe(false);
  });

  it("syncs workouts from cycles into cardio_activity", async () => {
    const cycles = [fakeCycle()];
    server.use(...whoopHandlers(cycles));
    const provider = new WhoopProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "whoop"));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const workout = rows.find((r) => r.externalId === "abc12345-6789-0def-1234-567890abcdef");
    if (!workout) throw new Error("expected workout abc12345-...");
    expect(workout.activityType).toBe("running");
    expect(workout.startedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
    expect(workout.endedAt).toEqual(new Date("2026-03-01T11:00:00Z"));
    // Summary data stored in raw JSONB
    const workoutRaw: Record<string, unknown> = Object.assign(
      Object.create(null),
      workout.raw ?? {},
    );
    expect(workoutRaw.avgHeartRate).toBe(155);
    expect(workoutRaw.maxHeartRate).toBe(185);
  });

  it("syncs multiple workouts from a single cycle", async () => {
    const twoWorkoutCycle = fakeCycle({
      id: 200,
      days: ["2026-03-05"],
      workouts: [
        {
          activity_id: "wl-2001-uuid",
          during: "['2026-03-05T08:00:00Z','2026-03-05T09:00:00Z')",
          timezone_offset: "-05:00",
          sport_id: 45, // weightlifting
          average_heart_rate: 130,
          max_heart_rate: 160,
          kilojoules: 1200,
          percent_recorded: 100,
          score: 8.5,
        },
        {
          activity_id: "cy-2002-uuid",
          during: "['2026-03-05T17:00:00Z','2026-03-05T18:00:00Z')",
          timezone_offset: "-05:00",
          sport_id: 1, // cycling
          average_heart_rate: 160,
          max_heart_rate: 190,
          kilojoules: 3000,
          percent_recorded: 98,
          score: 14.2,
        },
      ],
    });

    server.use(...whoopHandlers([twoWorkoutCycle]));
    const provider = new WhoopProvider();
    await provider.sync(ctx.db, new Date("2026-03-04T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "whoop"));

    const lift = rows.find((r) => r.externalId === "wl-2001-uuid");
    if (!lift) throw new Error("expected workout wl-2001-uuid");
    expect(lift.activityType).toBe("weightlifting");

    const ride = rows.find((r) => r.externalId === "cy-2002-uuid");
    if (!ride) throw new Error("expected workout cy-2002-uuid");
    expect(ride.activityType).toBe("cycling");
  });

  it("syncs HR stream into metric_stream", async () => {
    const hrValues = fakeHrValues(50, new Date("2026-03-01T10:00:00Z").getTime());
    server.use(...whoopHandlers([], { hrValues }));
    const provider = new WhoopProvider();
    const result = await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(metricStream)
      .where(eq(metricStream.providerId, "whoop"));

    expect(rows.length).toBeGreaterThanOrEqual(50);
    const withHr = rows.filter((r) => r.heartRate !== null);
    expect(withHr.length).toBeGreaterThanOrEqual(50);
  });

  it("upserts workouts on re-sync (no duplicates)", async () => {
    const cycles = [
      fakeCycle({
        id: 300,
        workouts: [
          {
            activity_id: "upsert-test-5001-uuid",
            during: "['2026-03-08T10:00:00Z','2026-03-08T11:00:00Z')",
            timezone_offset: "-05:00",
            sport_id: 0,
            average_heart_rate: 145,
            max_heart_rate: 175,
            kilojoules: 2000,
            percent_recorded: 100,
            score: 10,
          },
        ],
      }),
    ];

    server.use(...whoopHandlers(cycles));
    const provider = new WhoopProvider();
    await provider.sync(ctx.db, new Date("2026-03-07T00:00:00Z"));
    await provider.sync(ctx.db, new Date("2026-03-07T00:00:00Z"));

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(
        and(eq(activity.providerId, "whoop"), eq(activity.externalId, "upsert-test-5001-uuid")),
      );

    expect(rows).toHaveLength(1);
  });

  it("uses stored userId from scopes when bootstrap returns no user ID", async () => {
    // Save tokens with userId in scopes (as the auth flow does)
    await saveTokens(ctx.db, "whoop", {
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      scopes: "userId:10129",
    });

    // Override bootstrap to return NO user ID — must come before whoopHandlers
    // spread so MSW matches it first
    server.use(
      http.get("https://api.prod.whoop.com/users-service/v2/bootstrap/", () => {
        return HttpResponse.json({ profile: { name: "Test" } });
      }),
      ...whoopHandlers([fakeCycle()]),
    );

    const provider = new WhoopProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Should succeed using stored userId, not fail with "user 0" error
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThan(0);
  });

  it("preserves userId in scopes after token refresh", async () => {
    await saveTokens(ctx.db, "whoop", {
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      scopes: "userId:10129",
    });

    server.use(...whoopHandlers([fakeCycle()]));
    const provider = new WhoopProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // After sync, the scopes should still contain the userId
    const { loadTokens: load } = await import("../../db/tokens.ts");
    const tokens = await load(ctx.db, "whoop");
    expect(tokens?.scopes).toMatch(/userId:\d+/);
  });

  it("returns error when no tokens exist at all", async () => {
    // Remove all tokens for whoop
    const { oauthToken } = await import("../../db/schema.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "whoop"));

    const provider = new WhoopProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("not connected");
    expect(result.recordsSynced).toBe(0);

    // Restore tokens for other tests
    await saveTokens(ctx.db, "whoop", {
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      scopes: "userId:10129",
    });
  });

  it("syncs journal entries from behavior-impact-service", async () => {
    await saveTokens(ctx.db, "whoop", {
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      scopes: "userId:10129",
    });

    // Override to return journal data and empty cycles
    server.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json({
          AuthenticationResult: {
            AccessToken: "test-token",
            RefreshToken: "test-refresh",
          },
        });
      }),
      http.get("https://api.prod.whoop.com/users-service/v2/bootstrap/", () => {
        return HttpResponse.json({ id: 10129 });
      }),
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return HttpResponse.json([]);
      }),
      http.get("https://api.prod.whoop.com/metrics-service/v1/metrics/user/:userId", () => {
        return HttpResponse.json({ values: [] });
      }),
      http.get("https://api.prod.whoop.com/behavior-impact-service/v1/impact", () => {
        return HttpResponse.json([
          {
            date: "2026-03-01T00:00:00Z",
            answers: [
              { name: "caffeine", value: 2, impact: 0.5 },
              { name: "alcohol", value: 0, impact: -0.1 },
              { name: "melatonin", answer: "yes", impact: 0.3 },
            ],
          },
        ]);
      }),
    );

    const provider = new WhoopProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-28T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    const { journalEntry } = await import("../../db/schema.ts");
    const rows = await ctx.db
      .select()
      .from(journalEntry)
      .where(eq(journalEntry.providerId, "whoop"));

    expect(rows.length).toBeGreaterThanOrEqual(3);
    const caffeine = rows.find((r) => r.question === "caffeine");
    expect(caffeine).toBeDefined();
    expect(caffeine?.answerNumeric).toBe(2);
    expect(caffeine?.impactScore).toBe(0.5);
  });

  it("handles auth failure gracefully", async () => {
    server.use(...whoopHandlers([], { authError: true }));
    const provider = new WhoopProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toMatch(/refresh failed|auth/i);
  });

  it("continues syncing other data types if workout sync fails", async () => {
    // Cycle with invalid workout (bad during range) that will cause an error
    const cycle = fakeCycle({
      workouts: [
        {
          activity_id: "bad-workout-uuid",
          during: "invalid-range",
          timezone_offset: "-05:00",
          sport_id: 0,
          score: 10,
        },
      ],
    });

    server.use(...whoopHandlers([cycle]));
    const provider = new WhoopProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Should have synced recovery + sleep even if workout failed
    expect(result.recordsSynced).toBeGreaterThan(0);
  });
});
