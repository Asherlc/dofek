import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.js";
import { activity, dailyMetrics, metricStream, sleepSession } from "../../db/schema.js";
import { ensureProvider } from "../../db/tokens.js";
import {
  type WhoopHrValue,
  WhoopProvider,
  type WhoopRecoveryRecord,
  type WhoopSleepRecord,
  type WhoopWorkoutRecord,
} from "../whoop.js";

// ============================================================
// Fake WHOOP internal API cycle response
// The BFF endpoint returns cycles with recovery, sleep, and
// workouts embedded in each cycle object.
// ============================================================

interface FakeCycle {
  id: number;
  user_id: number;
  days: string[];
  recovery?: WhoopRecoveryRecord;
  sleep?: { id: number };
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
    strain: {
      workouts: [
        {
          id: 1043,
          user_id: 10129,
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T11:00:00Z",
          start: "2026-03-01T10:00:00Z",
          end: "2026-03-01T11:00:00Z",
          timezone_offset: "-05:00",
          sport_id: 0, // running
          score_state: "SCORED",
          score: {
            strain: 12.5,
            average_heart_rate: 155,
            max_heart_rate: 185,
            kilojoule: 2500.5,
            percent_recorded: 100,
            distance_meter: 10000,
            altitude_gain_meter: 150.5,
            altitude_change_meter: -5.2,
            zone_duration: {
              zone_zero_milli: 60000,
              zone_one_milli: 300000,
              zone_two_milli: 900000,
              zone_three_milli: 1200000,
              zone_four_milli: 600000,
              zone_five_milli: 300000,
            },
          },
        },
      ],
    },
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

function createMockFetch(
  cycles: FakeCycle[],
  opts?: { hrValues?: WhoopHrValue[]; authError?: boolean },
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = input.toString();

    // Auth
    if (urlStr.includes("/oauth/token")) {
      if (opts?.authError) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json({
        access_token: "test-token",
        user: { id: 10129 },
      });
    }

    // Cycles
    if (urlStr.includes("/cycles")) {
      return Response.json(cycles);
    }

    // Sleep by ID
    const sleepMatch = urlStr.match(/\/sleeps\/(\d+)/);
    if (sleepMatch) {
      return Response.json(fakeSleepResponse);
    }

    // Heart rate
    if (urlStr.includes("/metrics/heart_rate")) {
      const values = opts?.hrValues ?? fakeHrValues(100, Date.now() - 600000);
      return Response.json({ values });
    }

    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("WhoopProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "whoop", "WHOOP");
  }, 60_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("syncs recovery into daily_metrics with spo2 and skin temp", async () => {
    const cycles = [fakeCycle()];
    const provider = new WhoopProvider(createMockFetch(cycles));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "whoop"));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const day = rows.find((r) => r.date === "2026-03-01")!;
    expect(day.restingHr).toBe(52);
    expect(day.hrv).toBeCloseTo(65.5);
    expect(day.spo2Avg).toBeCloseTo(97.2);
    expect(day.skinTempC).toBeCloseTo(33.7);
  });

  it("syncs sleep sessions", async () => {
    const cycles = [fakeCycle()];
    const provider = new WhoopProvider(createMockFetch(cycles));
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const rows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "whoop"));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const session = rows.find((r) => r.externalId === "10235")!;
    expect(session.deepMinutes).toBe(120);
    expect(session.remMinutes).toBe(90);
    expect(session.efficiencyPct).toBeCloseTo(91.7);
    expect(session.isNap).toBe(false);
  });

  it("syncs workouts from cycles into cardio_activity", async () => {
    const cycles = [fakeCycle()];
    const provider = new WhoopProvider(createMockFetch(cycles));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "whoop"));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const workout = rows.find((r) => r.externalId === "1043")!;
    expect(workout.activityType).toBe("running");
    expect(workout.startedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
    expect(workout.endedAt).toEqual(new Date("2026-03-01T11:00:00Z"));
    // Summary data stored in raw JSONB
    expect((workout.raw as Record<string, unknown>).avgHeartRate).toBe(155);
    expect((workout.raw as Record<string, unknown>).maxHeartRate).toBe(185);
    expect((workout.raw as Record<string, unknown>).distanceMeters).toBe(10000);
  });

  it("syncs multiple workouts from a single cycle", async () => {
    const twoWorkoutCycle = fakeCycle({
      id: 200,
      days: ["2026-03-05"],
      strain: {
        workouts: [
          {
            id: 2001,
            user_id: 10129,
            created_at: "2026-03-05T08:00:00Z",
            updated_at: "2026-03-05T09:00:00Z",
            start: "2026-03-05T08:00:00Z",
            end: "2026-03-05T09:00:00Z",
            timezone_offset: "-05:00",
            sport_id: 45, // weightlifting
            score_state: "SCORED",
            score: {
              strain: 8.5,
              average_heart_rate: 130,
              max_heart_rate: 160,
              kilojoule: 1200,
              percent_recorded: 100,
              zone_duration: {},
            },
          },
          {
            id: 2002,
            user_id: 10129,
            created_at: "2026-03-05T17:00:00Z",
            updated_at: "2026-03-05T18:00:00Z",
            start: "2026-03-05T17:00:00Z",
            end: "2026-03-05T18:00:00Z",
            timezone_offset: "-05:00",
            sport_id: 1, // cycling
            score_state: "SCORED",
            score: {
              strain: 14.2,
              average_heart_rate: 160,
              max_heart_rate: 190,
              kilojoule: 3000,
              percent_recorded: 98,
              distance_meter: 25000,
              altitude_gain_meter: 300,
              altitude_change_meter: 10,
              zone_duration: {},
            },
          },
        ],
      },
    });

    const provider = new WhoopProvider(createMockFetch([twoWorkoutCycle]));
    await provider.sync(ctx.db, new Date("2026-03-04T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "whoop"));

    const lift = rows.find((r) => r.externalId === "2001")!;
    expect(lift.activityType).toBe("weightlifting");

    const ride = rows.find((r) => r.externalId === "2002")!;
    expect(ride.activityType).toBe("cycling");
  });

  it("syncs HR stream into metric_stream", async () => {
    const hrValues = fakeHrValues(50, new Date("2026-03-01T10:00:00Z").getTime());
    const provider = new WhoopProvider(createMockFetch([], { hrValues }));
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
        strain: {
          workouts: [
            {
              id: 5001,
              user_id: 10129,
              created_at: "2026-03-08T10:00:00Z",
              updated_at: "2026-03-08T11:00:00Z",
              start: "2026-03-08T10:00:00Z",
              end: "2026-03-08T11:00:00Z",
              timezone_offset: "-05:00",
              sport_id: 0,
              score_state: "SCORED",
              score: {
                strain: 10,
                average_heart_rate: 145,
                max_heart_rate: 175,
                kilojoule: 2000,
                percent_recorded: 100,
                zone_duration: {},
              },
            },
          ],
        },
      }),
    ];

    const provider = new WhoopProvider(createMockFetch(cycles));
    await provider.sync(ctx.db, new Date("2026-03-07T00:00:00Z"));
    await provider.sync(ctx.db, new Date("2026-03-07T00:00:00Z"));

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(and(eq(activity.providerId, "whoop"), eq(activity.externalId, "5001")));

    expect(rows).toHaveLength(1);
  });

  it("handles auth failure gracefully", async () => {
    const provider = new WhoopProvider(createMockFetch([], { authError: true }));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain("auth");
  });

  it("continues syncing other data types if workout sync fails", async () => {
    // Cycle with invalid workout that will cause an error
    const cycle = fakeCycle({
      strain: {
        workouts: [
          {
            id: 9999,
            user_id: 10129,
            created_at: "invalid-date",
            updated_at: "invalid-date",
            start: "invalid-date",
            end: "invalid-date",
            timezone_offset: "-05:00",
            sport_id: 0,
            score_state: "SCORED",
            score: {
              strain: 10,
              average_heart_rate: 145,
              max_heart_rate: 175,
              kilojoule: 2000,
              percent_recorded: 100,
              zone_duration: {},
            },
          },
        ],
      },
    });

    const provider = new WhoopProvider(createMockFetch([cycle]));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Should have synced recovery + sleep even if workout failed
    expect(result.recordsSynced).toBeGreaterThan(0);
  });
});
