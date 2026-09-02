import { WhoopClient } from "@dofek/whoop/client";
import type {
  WhoopHrValue,
  WhoopRecoveryRecord,
  WhoopSleepRecord,
  WhoopWorkoutRecord,
} from "@dofek/whoop/types";
import { parseDuringRange } from "@dofek/whoop/utils";
import { and, desc, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activity, dailyMetrics, sleepSession, sleepStage } from "../db/schema/activity.ts";
import { TEST_USER_ID } from "../db/schema/core.ts";
import { journalEntry, syncLog } from "../db/schema/events.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createCapturingMetricStreamPublisher } from "./test-helpers.ts";
import { WhoopProvider } from "./whoop/provider.ts";

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
  sleeps?: Record<string, unknown>[];
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
    sleeps: [
      {
        during: "['2026-02-28T23:00:00Z','2026-03-01T06:30:00Z')",
        state: "complete",
        time_in_bed: 27000000,
        wake_duration: 1800000,
        light_sleep_duration: 10800000,
        slow_wave_sleep_duration: 7200000,
        rem_sleep_duration: 5400000,
        in_sleep_efficiency: 91.7,
        habitual_sleep_need: 28800000,
        debt_post: 1800000,
        need_from_strain: 900000,
        credit_from_naps: 0,
        significant: true,
      },
    ],
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

function fakeStrainDeepDiveResponse(steps: number): Record<string, unknown> {
  return {
    sections: [
      {
        items: [
          {
            type: "CONTRIBUTORS_TILE",
            content: {
              id: "STRAIN_CONTRIBUTORS_TILE",
              metrics: [
                {
                  id: "CONTRIBUTORS_TILE_STEPS",
                  status: steps.toLocaleString("en-US"),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

type DeveloperWorkoutStub = {
  id: string;
  start: string;
  end: string;
  sport_name?: string;
};

function extractDeveloperWorkoutsFromCycles(cycles: FakeCycle[]): DeveloperWorkoutStub[] {
  const workouts: DeveloperWorkoutStub[] = [];
  for (const cycle of cycles) {
    for (const workout of cycle.workouts ?? cycle.strain?.workouts ?? []) {
      const id =
        workout.activity_id != null && workout.activity_id !== ""
          ? String(workout.activity_id)
          : workout.id != null
            ? String(workout.id)
            : null;
      if (!id) continue;

      let start = workout.start;
      let end = workout.end;
      if (workout.during) {
        try {
          const range = parseDuringRange(workout.during);
          start = range.start.toISOString();
          end = range.end.toISOString();
        } catch {
          continue;
        }
      }
      if (!start || !end) continue;
      workouts.push({ id, start, end });
    }
  }
  return workouts;
}

function whoopHandlers(
  cycles: FakeCycle[],
  opts?: {
    hrValues?: WhoopHrValue[];
    stepsByDate?: Record<string, number>;
    authError?: boolean;
    /** Per-activityId response for GET sleep-events (detailed sleep + stages). */
    sleepDetailByActivityId?: Record<string, WhoopSleepRecord>;
    /** Developer workout list for provider-absence reconciliation. */
    developerWorkouts?: DeveloperWorkoutStub[];
  },
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

    // Developer workout list (authoritative for tombstoning deletions)
    http.get("https://api.prod.whoop.com/developer/v2/activity/workout", () => {
      const records = opts?.developerWorkouts ?? extractDeveloperWorkoutsFromCycles(cycles);
      return HttpResponse.json({ records, next_token: null });
    }),

    // Weightlifting-service — return 404 unless overridden
    http.get(
      "https://api.prod.whoop.com/weightlifting-service/v2/weightlifting-workout/:activityId",
      () => {
        return new HttpResponse("Not found", { status: 404 });
      },
    ),

    // Sleep events (list or single-sleep fetch via activityId)
    http.get("https://api.prod.whoop.com/sleep-service/v1/sleep-events", ({ request }) => {
      const url = new URL(request.url);
      const activityId = url.searchParams.get("activityId") ?? "";
      const detail = opts?.sleepDetailByActivityId?.[activityId];
      if (detail) {
        return HttpResponse.json(detail);
      }
      return HttpResponse.json(fakeSleepResponse);
    }),

    // Metrics (metrics-service): heart_rate only
    http.get(
      "https://api.prod.whoop.com/metrics-service/v1/metrics/user/:userId",
      ({ request }) => {
        const metricName = new URL(request.url).searchParams.get("name");
        if (metricName === "steps") {
          return HttpResponse.json(
            { code: 400, message: "query param name must be one of [heart_rate]" },
            { status: 400 },
          );
        }
        const values = opts?.hrValues ?? fakeHrValues(100, Date.now() - 600000);
        return HttpResponse.json({ values });
      },
    ),

    // Strain deep-dive BFF (daily steps)
    http.get("https://api.prod.whoop.com/home-service/v1/deep-dive/strain", ({ request }) => {
      const date = new URL(request.url).searchParams.get("date") ?? "";
      const steps = opts?.stepsByDate?.[date];
      if (steps == null) {
        return HttpResponse.json({ sections: [] });
      }
      return HttpResponse.json(fakeStrainDeepDiveResponse(steps));
    }),

    // Journal / behavior-impact-service
    http.get("https://api.prod.whoop.com/behavior-impact-service/v1/impact", () => {
      return HttpResponse.json([]);
    }),
  ];
}

const server = setupServer();
const metricStreamCapture = createCapturingMetricStreamPublisher();

describe("WhoopProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, "whoop", "WHOOP");
    // Store a fake refresh token so the provider can authenticate
    await saveTokens(ctx.db, "whoop", {
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      scopes: "userId:10129",
    });
  }, 60_000);

  beforeEach(() => {
    metricStreamCapture.publishedMetricStreamRows.length = 0;
  });

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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "whoop"));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const day = rows.find((r) => r.date === "2026-03-01");
    if (!day) throw new Error("expected day 2026-03-01");
    expect(day.hrv).toBeCloseTo(65.5);
    expect(day.spo2Avg).toBeCloseTo(97.2);
    expect(day.skinTempC).toBeCloseTo(33.7);
  });

  it("syncs BFF v0 flat recovery format into daily_metrics", async () => {
    const cycles = [
      fakeCycle({
        recovery: {
          cycle_id: 100,
          sleep_id: 10235,
          user_id: 10129,
          created_at: "2026-03-01T11:25:44.774Z",
          updated_at: "2026-03-01T14:25:44.774Z",
          score_state: "complete",
          recovery_score: 88,
          resting_heart_rate: 57,
          hrv_rmssd: 0.077110276,
          spo2_percentage: 96.5,
          skin_temp_celsius: 34.2,
          calibrating: false,
        },
      }),
    ];
    server.use(...whoopHandlers(cycles));
    const provider = new WhoopProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.duration).toBeLessThan(60_000);

    const rows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "whoop"));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const day = rows.find((r) => r.date === "2026-03-01");
    if (!day) throw new Error("expected day 2026-03-01");
    expect(day.hrv).toBeCloseTo(77.1, 0);
    expect(day.spo2Avg).toBeCloseTo(96.5);
    expect(day.skinTempC).toBeCloseTo(34.2);
  });

  it("syncs daily steps from strain deep-dive into daily_metrics", async () => {
    const cycles = [fakeCycle({ days: ["2026-03-01"] })];
    server.use(
      ...whoopHandlers(cycles, {
        stepsByDate: {
          "2026-03-01": 7421,
          "2026-03-02": 9100,
        },
      }),
    );
    const provider = new WhoopProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "whoop"));

    const march1 = rows.find((row) => row.date === "2026-03-01");
    const march2 = rows.find((row) => row.date === "2026-03-02");
    expect(march1?.steps).toBe(7421);
    expect(march2?.steps).toBe(9100);
  });

  it("skips daily steps when strain deep-dive has no contributors tile", async () => {
    const cycles = [fakeCycle({ days: ["2026-03-01"] })];
    server.use(...whoopHandlers(cycles));
    const provider = new WhoopProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);

    const [dailyActivityLog] = await ctx.db
      .select()
      .from(syncLog)
      .where(and(eq(syncLog.providerId, "whoop"), eq(syncLog.dataType, "daily_activity")))
      .orderBy(desc(syncLog.syncedAt))
      .limit(1);
    expect(dailyActivityLog?.status).toBe("success");
    expect(dailyActivityLog?.errorMessage).toBeNull();
  });

  it("syncs sleep sessions", async () => {
    const cycles = [fakeCycle()];
    server.use(...whoopHandlers(cycles));
    const provider = new WhoopProvider();
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    const rows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "whoop"));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const session = rows[0];
    if (!session) throw new Error("expected at least one sleep session");
    expect(session.deepMinutes).toBe(120);
    expect(session.remMinutes).toBe(90);
    expect(session.efficiencyPct).toBeCloseTo(91.7);
    expect(session.sleepType).toBe("sleep");
    expect(session.startedAt).toEqual(new Date("2026-02-28T23:00:00Z"));
    expect(session.endedAt).toEqual(new Date("2026-03-01T06:30:00Z"));
  });

  it("syncs per-stage timings into sleep_stage when session exists for sleep id", async () => {
    server.use(
      ...whoopHandlers([fakeCycle()], {
        sleepDetailByActivityId: {
          "10235": {
            ...fakeSleepResponse,
            stages: [
              { stage: "light", during: "['2026-02-28T23:00:00Z','2026-02-28T23:30:00Z')" },
              { stage: "deep", during: "['2026-02-28T23:30:00Z','2026-03-01T01:00:00Z')" },
            ],
          },
        },
      }),
    );

    const provider = new WhoopProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(
      result.errors.filter((syncError) => syncError.message.includes("sleep_stages")),
    ).toHaveLength(0);

    const sessions = await ctx.db
      .select({ id: sleepSession.id })
      .from(sleepSession)
      .where(and(eq(sleepSession.providerId, "whoop"), eq(sleepSession.externalId, "10235")));
    const sessionId = sessions[0]?.id;
    if (!sessionId) throw new Error("expected synced sleep session with WHOOP sleep id");

    const stageRows = await ctx.db
      .select()
      .from(sleepStage)
      .where(eq(sleepStage.sessionId, sessionId));
    expect(stageRows).toHaveLength(2);
    expect(stageRows.map((row) => row.stage).sort()).toEqual(["deep", "light"]);
  });

  it("syncs per-stage timings into sleep_stage when session exists for sleep id (legacy seed path)", async () => {
    const existingSessions = await ctx.db
      .select({ id: sleepSession.id })
      .from(sleepSession)
      .where(and(eq(sleepSession.providerId, "whoop"), eq(sleepSession.externalId, "10235")));

    for (const row of existingSessions) {
      await ctx.db.delete(sleepStage).where(eq(sleepStage.sessionId, row.id));
    }
    await ctx.db
      .delete(sleepSession)
      .where(and(eq(sleepSession.providerId, "whoop"), eq(sleepSession.externalId, "10235")));

    const cycles = [fakeCycle({ sleeps: [] })];
    server.use(
      ...whoopHandlers(cycles, {
        sleepDetailByActivityId: {
          "10235": {
            ...fakeSleepResponse,
            stages: [
              { stage: "light", during: "['2026-02-28T23:00:00Z','2026-02-28T23:30:00Z')" },
              { stage: "deep", during: "['2026-02-28T23:30:00Z','2026-03-01T01:00:00Z')" },
            ],
          },
        },
      }),
    );

    await ctx.db.insert(sleepSession).values({
      providerId: "whoop",
      userId: TEST_USER_ID,
      externalId: "10235",
      startedAt: new Date("2026-02-28T23:00:00Z"),
      endedAt: new Date("2026-03-01T06:30:00Z"),
      durationMinutes: 450,
      deepMinutes: 120,
      remMinutes: 90,
      lightMinutes: 180,
      awakeMinutes: 30,
      efficiencyPct: 91.7,
      sleepType: "sleep",
    });

    const provider = new WhoopProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(
      result.errors.filter((syncError) => syncError.message.includes("sleep_stages")),
    ).toHaveLength(0);

    const sessions = await ctx.db
      .select({ id: sleepSession.id })
      .from(sleepSession)
      .where(and(eq(sleepSession.providerId, "whoop"), eq(sleepSession.externalId, "10235")));
    const sessionId = sessions[0]?.id;
    if (!sessionId) throw new Error("expected seed sleep session");

    const stageRows = await ctx.db
      .select()
      .from(sleepStage)
      .where(eq(sleepStage.sessionId, sessionId));
    expect(stageRows).toHaveLength(2);
    expect(stageRows.map((row) => row.stage).sort()).toEqual(["deep", "light"]);
  });

  it("syncs workouts from cycles into cardio_activity", async () => {
    const cycles = [fakeCycle()];
    server.use(...whoopHandlers(cycles));
    const provider = new WhoopProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "whoop"));

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const workout = rows.find((r) => r.externalId === "abc12345-6789-0def-1234-567890abcdef");
    if (!workout) throw new Error("expected workout abc12345-...");
    expect(workout.canonicalType).toBe("running");
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
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-04T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "whoop"));

    const lift = rows.find((r) => r.externalId === "wl-2001-uuid");
    if (!lift) throw new Error("expected workout wl-2001-uuid");
    expect(lift.canonicalType).toBe("strength");

    const ride = rows.find((r) => r.externalId === "cy-2002-uuid");
    if (!ride) throw new Error("expected workout cy-2002-uuid");
    expect(ride.canonicalType).toBe("cycling");
  });

  it("syncs HR stream into Redpanda metric stream events", async () => {
    const hrValues = fakeHrValues(50, new Date("2026-03-01T10:00:00Z").getTime());
    server.use(...whoopHandlers([], { hrValues }));
    const provider = new WhoopProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);

    const rows = metricStreamCapture.publishedMetricStreamRows;
    const withHr = rows.filter((sample) => sample.channel === "heart_rate");
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
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-07T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-07T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(
        and(eq(activity.providerId, "whoop"), eq(activity.externalId, "upsert-test-5001-uuid")),
      );

    expect(rows).toHaveLength(1);
  });

  it("marks previously synced workouts absent when WHOOP no longer returns them", async () => {
    await ctx.db
      .insert(activity)
      .values({
        providerId: "whoop",
        externalId: "whoop-missing-workout-uuid",
        canonicalType: "running",
        providerType: "0",
        modality: null,
        startedAt: new Date("2026-03-10T10:00:00Z"),
      })
      .onConflictDoUpdate({
        target: [activity.userId, activity.providerId, activity.externalId],
        set: {
          providerAbsentAt: null,
        },
      });

    const cycles = [
      fakeCycle({
        id: 301,
        days: ["2026-03-10"],
        workouts: [
          {
            activity_id: "whoop-present-workout-uuid",
            during: "['2026-03-10T12:00:00Z','2026-03-10T13:00:00Z')",
            timezone_offset: "-05:00",
            sport_id: -1,
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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-10T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(
        and(
          eq(activity.providerId, "whoop"),
          eq(activity.startedAt, new Date("2026-03-10T10:00:00Z")),
        ),
      );
    const missing = rows.find((row) => row.externalId === "whoop-missing-workout-uuid");
    const presentRows = await ctx.db
      .select()
      .from(activity)
      .where(
        and(
          eq(activity.providerId, "whoop"),
          eq(activity.externalId, "whoop-present-workout-uuid"),
        ),
      );

    expect(missing?.providerAbsentAt).toBeInstanceOf(Date);
    expect(presentRows[0]?.providerAbsentAt).toBeNull();
  });

  it("tombstones workouts deleted in WHOOP when cycles BFF still returns them", async () => {
    await ctx.db
      .insert(activity)
      .values({
        providerId: "whoop",
        externalId: "whoop-stale-bff-workout-uuid",
        canonicalType: "running",
        providerType: "0",
        modality: null,
        startedAt: new Date("2026-03-10T10:00:00Z"),
      })
      .onConflictDoUpdate({
        target: [activity.userId, activity.providerId, activity.externalId],
        set: {
          providerAbsentAt: null,
        },
      });

    const cycles = [
      fakeCycle({
        id: 302,
        days: ["2026-03-10"],
        workouts: [
          {
            activity_id: "whoop-stale-bff-workout-uuid",
            during: "['2026-03-10T10:00:00Z','2026-03-10T11:00:00Z')",
            timezone_offset: "-05:00",
            sport_id: 0,
            average_heart_rate: 145,
            max_heart_rate: 175,
            kilojoules: 2000,
            percent_recorded: 100,
            score: 10,
          },
          {
            activity_id: "whoop-present-workout-uuid",
            during: "['2026-03-10T12:00:00Z','2026-03-10T13:00:00Z')",
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

    server.use(
      ...whoopHandlers(cycles, {
        developerWorkouts: [
          {
            id: "whoop-present-workout-uuid",
            start: "2026-03-10T12:00:00Z",
            end: "2026-03-10T13:00:00Z",
            sport_name: "Commuting",
          },
        ],
      }),
    );
    const provider = new WhoopProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-10T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);

    const staleRows = await ctx.db
      .select()
      .from(activity)
      .where(
        and(
          eq(activity.providerId, "whoop"),
          eq(activity.externalId, "whoop-stale-bff-workout-uuid"),
        ),
      );
    const presentRows = await ctx.db
      .select()
      .from(activity)
      .where(
        and(
          eq(activity.providerId, "whoop"),
          eq(activity.externalId, "whoop-present-workout-uuid"),
        ),
      );

    expect(staleRows[0]?.providerAbsentAt).toBeInstanceOf(Date);
    expect(presentRows[0]?.providerAbsentAt).toBeNull();
    expect(presentRows[0]?.canonicalType).toBe("cycling");
    expect(presentRows[0]?.providerType).toBe("Commuting");
  });

  it("keeps tombstones after a later sync phase upserts stale provider data", async () => {
    await ctx.db
      .insert(activity)
      .values({
        providerId: "whoop",
        externalId: "whoop-stale-strength-uuid",
        canonicalType: "strength",
        providerType: "45",
        modality: null,
        startedAt: new Date("2026-03-10T10:00:00Z"),
      })
      .onConflictDoUpdate({
        target: [activity.userId, activity.providerId, activity.externalId],
        set: {
          providerAbsentAt: null,
        },
      });

    const cycles = [
      fakeCycle({
        id: 303,
        days: ["2026-03-10"],
        workouts: [
          {
            activity_id: "whoop-stale-strength-uuid",
            during: "['2026-03-10T10:00:00Z','2026-03-10T11:00:00Z')",
            timezone_offset: "-05:00",
            sport_id: 45,
            average_heart_rate: 130,
            max_heart_rate: 160,
            kilojoules: 1200,
            percent_recorded: 100,
            score: 8.5,
          },
        ],
      }),
    ];

    const weightliftingPayload = {
      activity_id: "whoop-stale-strength-uuid",
      user_id: 10129,
      during: "['2026-03-10T10:00:00Z','2026-03-10T11:00:00Z')",
      total_effective_volume_kg: 600,
      raw_msk_strain_score: 8,
      scaled_msk_strain_score: 7.5,
      cardio_strain_score: 4,
      cardio_strain_contribution_percent: 30,
      msk_strain_contribution_percent: 70,
      zone_durations: {
        zone0_to10_duration: 0,
        zone10_to20_duration: 0,
        zone20_to30_duration: 0,
        zone30_to40_duration: 0,
        zone40_to50_duration: 0,
        zone50_to60_duration: 0,
        zone60_to70_duration: 0,
        zone70_to80_duration: 0,
        zone80_to90_duration: 0,
        zone90_to100_duration: 0,
      },
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 60,
                  number_of_reps: 10,
                  msk_total_volume_kg: 600,
                  time_in_seconds: 0,
                  during: "['2026-03-10T10:05:00Z','2026-03-10T10:05:30Z')",
                  complete: true,
                },
              ],
              exercise_details: {
                exercise_id: "BENCHPRESS",
                name: "Bench Press",
                equipment: "BARBELL",
                exercise_type: "STRENGTH",
                muscle_groups: ["CHEST"],
                volume_input_format: "REPS",
              },
            },
          ],
        },
      ],
    };

    server.use(
      http.get(
        "https://api.prod.whoop.com/weightlifting-service/v2/weightlifting-workout/:activityId",
        ({ params }) => {
          if (params.activityId === "whoop-stale-strength-uuid") {
            return HttpResponse.json(weightliftingPayload);
          }
          return new HttpResponse("Not found", { status: 404 });
        },
      ),
      ...whoopHandlers(cycles, {
        developerWorkouts: [
          {
            id: "whoop-present-strength-window-uuid",
            start: "2026-03-10T08:00:00Z",
            end: "2026-03-10T09:00:00Z",
          },
        ],
      }),
    );
    const provider = new WhoopProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-10T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.duration).toBeLessThan(60_000);

    const staleRows = await ctx.db
      .select()
      .from(activity)
      .where(
        and(eq(activity.providerId, "whoop"), eq(activity.externalId, "whoop-stale-strength-uuid")),
      );

    expect(staleRows[0]?.providerAbsentAt).toBeInstanceOf(Date);
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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // Should succeed using stored userId, not fail with "user 0" error
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThan(0);
  });

  it("preserves userId in scopes after token refresh", async () => {
    await saveTokens(ctx.db, "whoop", {
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      scopes: "userId:10129",
    });

    server.use(...whoopHandlers([fakeCycle()]));
    const provider = new WhoopProvider();
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // After sync, the scopes should still contain the userId
    const { loadTokens: load } = await import("../db/tokens.ts");
    const tokens = await load(ctx.db, "whoop");
    expect(tokens?.scopes).toMatch(/userId:\d+/);
  });

  it("returns error when no tokens exist at all", async () => {
    // Remove all tokens for whoop
    const { oauthToken } = await import("../db/schema/reference.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "whoop"));

    const provider = new WhoopProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

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
      http.get("https://api.prod.whoop.com/developer/v2/activity/workout", () => {
        return HttpResponse.json({ records: [], next_token: null });
      }),
      http.get("https://api.prod.whoop.com/metrics-service/v1/metrics/user/:userId", () => {
        return HttpResponse.json({ values: [] });
      }),
      http.get("https://api.prod.whoop.com/home-service/v1/deep-dive/strain", () => {
        return HttpResponse.json({ sections: [] });
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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-28T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);

    const { journalEntry } = await import("../db/schema/events.ts");
    const rows = await ctx.db
      .select()
      .from(journalEntry)
      .where(eq(journalEntry.providerId, "whoop"));

    expect(rows.length).toBeGreaterThanOrEqual(3);
    const caffeine = rows.find((r) => r.questionSlug === "caffeine");
    expect(caffeine).toBeDefined();
    expect(caffeine?.answerNumeric).toBe(2);
    expect(caffeine?.impactScore).toBe(0.5);
  });

  it("handles auth failure gracefully", async () => {
    await saveTokens(ctx.db, "whoop", {
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      scopes: "userId:10129",
    });
    server.use(...whoopHandlers([], { authError: true }));
    const provider = new WhoopProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("refresh token was revoked or expired");
    expect(result.errors[0]?.cause).toMatchObject({ authFailureReason: "refresh_token_revoked" });

    const { loadTokens } = await import("../db/tokens.ts");
    await expect(loadTokens(ctx.db, "whoop")).resolves.toBeNull();

    await saveTokens(ctx.db, "whoop", {
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      scopes: "userId:10129",
    });
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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // Should have synced recovery + sleep even if workout failed
    expect(result.recordsSynced).toBeGreaterThan(0);
  });

  it("catches HR stream errors and continues to journal sync", async () => {
    server.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json({
          AuthenticationResult: { AccessToken: "test-token", RefreshToken: "test-refresh" },
        });
      }),
      http.get("https://api.prod.whoop.com/users-service/v2/bootstrap/", () => {
        return HttpResponse.json({ id: 10129 });
      }),
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return HttpResponse.json([]);
      }),
      http.get(
        "https://api.prod.whoop.com/weightlifting-service/v2/weightlifting-workout/:id",
        () => {
          return new HttpResponse("Not found", { status: 404 });
        },
      ),
      http.get("https://api.prod.whoop.com/metrics-service/v1/metrics/user/:userId", () => {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }),
      http.get("https://api.prod.whoop.com/developer/v2/activity/workout", () => {
        return HttpResponse.json({ records: [], next_token: null });
      }),
      http.get("https://api.prod.whoop.com/home-service/v1/deep-dive/strain", () => {
        return HttpResponse.json({ sections: [] });
      }),
      http.get("https://api.prod.whoop.com/behavior-impact-service/v1/impact", () => {
        return HttpResponse.json([
          {
            date: "2026-03-01T00:00:00Z",
            answers: [{ name: "caffeine", value: 1, impact: 0.2 }],
          },
        ]);
      }),
    );

    const provider = new WhoopProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-28T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // Should have an hr_stream error
    const hrError = result.errors.find((e) => e.message.includes("hr_stream"));
    expect(hrError).toBeDefined();

    // Journal should still have been synced
    const rows = await ctx.db
      .select()
      .from(journalEntry)
      .where(eq(journalEntry.providerId, "whoop"));
    const caffeine = rows.find((r) => r.questionSlug === "caffeine");
    expect(caffeine).toBeDefined();
  });

  it("catches journal errors gracefully", async () => {
    server.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json({
          AuthenticationResult: { AccessToken: "test-token", RefreshToken: "test-refresh" },
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
      http.get("https://api.prod.whoop.com/developer/v2/activity/workout", () => {
        return HttpResponse.json({ records: [], next_token: null });
      }),
      http.get(
        "https://api.prod.whoop.com/weightlifting-service/v2/weightlifting-workout/:id",
        () => {
          return new HttpResponse("Not found", { status: 404 });
        },
      ),
      http.get("https://api.prod.whoop.com/home-service/v1/deep-dive/strain", () => {
        return HttpResponse.json({ sections: [] });
      }),
      http.get("https://api.prod.whoop.com/behavior-impact-service/v1/impact", () => {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }),
    );

    const provider = new WhoopProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-28T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // Should have a journal error
    const journalError = result.errors.find((e) => e.message.includes("journal"));
    expect(journalError).toBeDefined();
  });
});

describe("WhoopClient — verifyCode", () => {
  const clientServer = setupServer();

  beforeAll(() => {
    clientServer.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
  });

  afterEach(() => {
    clientServer.resetHandlers();
  });

  afterAll(() => {
    clientServer.close();
  });

  it("verifies code via SMS_MFA challenge", async () => {
    clientServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", async ({ request }) => {
        const raw = await request.json();
        const body =
          typeof raw === "object" && raw !== null ? (raw satisfies Record<string, unknown>) : {};
        if (body.ChallengeName === "SMS_MFA") {
          return HttpResponse.json({
            AuthenticationResult: {
              AccessToken: "verified-tok",
              RefreshToken: "verified-ref",
              ExpiresIn: 3600,
            },
          });
        }
        return HttpResponse.json(
          { __type: "#CodeMismatchException", message: "Wrong code" },
          { status: 400 },
        );
      }),
      http.get("https://api.prod.whoop.com/users-service/v2/bootstrap/", () => {
        return HttpResponse.json({ id: 55 });
      }),
    );

    const token = await WhoopClient.verifyCode("session-xyz", "123456", "user@test.com", "sms");
    expect(token.accessToken).toBe("verified-tok");
    expect(token.userId).toBe(55);
  });

  it("verifies code via SOFTWARE_TOKEN_MFA challenge when method is totp", async () => {
    const challengeNames: string[] = [];

    clientServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", async ({ request }) => {
        const raw = await request.json();
        const body =
          typeof raw === "object" && raw !== null ? (raw satisfies Record<string, unknown>) : {};
        challengeNames.push(String(body.ChallengeName));
        expect(body.ChallengeResponses).toEqual({
          USERNAME: "user@test.com",
          SOFTWARE_TOKEN_MFA_CODE: "654321",
        });
        return HttpResponse.json({
          AuthenticationResult: {
            AccessToken: "totp-tok",
            RefreshToken: "totp-ref",
            ExpiresIn: 3600,
          },
        });
      }),
      http.get("https://api.prod.whoop.com/users-service/v2/bootstrap/", () => {
        return HttpResponse.json({ id: 77 });
      }),
    );

    const token = await WhoopClient.verifyCode("session-xyz", "654321", "user@test.com", "totp");
    expect(challengeNames).toEqual(["SOFTWARE_TOKEN_MFA"]);
    expect(token.accessToken).toBe("totp-tok");
    expect(token.userId).toBe(77);
  });

  it("throws when no tokens in verify response", async () => {
    clientServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json({ AuthenticationResult: {} });
      }),
    );

    await expect(
      WhoopClient.verifyCode("session", "123456", "user@test.com", "sms"),
    ).rejects.toThrow(/no tokens/i);
  });

  it("throws when bootstrap returns no userId during verifyCode", async () => {
    clientServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json({
          AuthenticationResult: { AccessToken: "tok", RefreshToken: "ref", ExpiresIn: 3600 },
        });
      }),
      http.get("https://api.prod.whoop.com/users-service/v2/bootstrap/", () => {
        return HttpResponse.json({ profile: {} });
      }),
    );

    await expect(
      WhoopClient.verifyCode("session", "123456", "user@test.com", "sms"),
    ).rejects.toThrow(/user ID/i);
  });
});

describe("WhoopClient — cognitoCall error paths", () => {
  const cognitoServer = setupServer();

  beforeAll(() => {
    cognitoServer.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
  });

  afterEach(() => {
    cognitoServer.resetHandlers();
  });

  afterAll(() => {
    cognitoServer.close();
  });

  it("throws on non-JSON Cognito response", async () => {
    cognitoServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return new HttpResponse("Not JSON", { status: 200 });
      }),
    );

    await expect(WhoopClient.signIn("user@test.com", "pass")).rejects.toThrow(/WHOOP auth failed/);
  });

  it("throws with error type from Cognito error response", async () => {
    cognitoServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json(
          {
            __type: "com.amazonaws.cognito#UserNotFoundException",
            message: "User does not exist",
          },
          { status: 400 },
        );
      }),
    );

    await expect(WhoopClient.signIn("nobody@test.com", "pass")).rejects.toThrow(
      /UserNotFoundException/,
    );
  });

  it("throws when signIn gets no AccessToken", async () => {
    cognitoServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json({ AuthenticationResult: {} });
      }),
    );

    await expect(WhoopClient.signIn("user@test.com", "pass")).rejects.toThrow(/no tokens/i);
  });

  it("throws when refreshAccessToken gets no AccessToken", async () => {
    cognitoServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json({ AuthenticationResult: {} });
      }),
    );

    await expect(WhoopClient.refreshAccessToken("old-ref")).rejects.toThrow(/no tokens/i);
  });
});

describe("WhoopClient — signIn SOFTWARE_TOKEN_MFA", () => {
  const mfaServer = setupServer();

  beforeAll(() => {
    mfaServer.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
  });

  afterEach(() => {
    mfaServer.resetHandlers();
  });

  afterAll(() => {
    mfaServer.close();
  });

  it("returns totp method for SOFTWARE_TOKEN_MFA challenge", async () => {
    mfaServer.use(
      http.post("https://api.prod.whoop.com/auth-service/v3/whoop/", () => {
        return HttpResponse.json({
          ChallengeName: "SOFTWARE_TOKEN_MFA",
          Session: "totp-session",
        });
      }),
    );

    const result = await WhoopClient.signIn("user@test.com", "pass");
    expect(result.type).toBe("verification_required");
    if (result.type === "verification_required") {
      expect(result.method).toBe("totp");
      expect(result.session).toBe("totp-session");
    }
  });
});

describe("WhoopClient._fetchUserId — bootstrap HTTP failure", () => {
  const bootstrapServer = setupServer();

  beforeAll(() => {
    bootstrapServer.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
  });

  afterEach(() => {
    bootstrapServer.resetHandlers();
  });

  afterAll(() => {
    bootstrapServer.close();
  });

  it("returns null when bootstrap returns non-200", async () => {
    bootstrapServer.use(
      http.get("https://api.prod.whoop.com/users-service/v2/bootstrap/", () => {
        return new HttpResponse("Unauthorized", { status: 401 });
      }),
    );

    const userId = await WhoopClient._fetchUserId("bad-token");
    expect(userId).toBeNull();
  });
});

describe("WhoopClient — getCycles response shapes", () => {
  const cyclesServer = setupServer();

  beforeAll(() => {
    cyclesServer.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
  });

  afterEach(() => {
    cyclesServer.resetHandlers();
  });

  afterAll(() => {
    cyclesServer.close();
  });

  it("handles wrapped object with 'records' key", async () => {
    cyclesServer.use(
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return HttpResponse.json({ records: [{ id: 1, user_id: 10, days: ["2026-03-01"] }] });
      }),
    );

    const client = new WhoopClient({
      accessToken: "tok",
      refreshToken: "ref",
      userId: 10,
      expiresInSeconds: 3600,
    });
    const cycles = await client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    expect(cycles).toHaveLength(1);
  });

  it("handles wrapped object with 'data' key", async () => {
    cyclesServer.use(
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return HttpResponse.json({ data: [{ id: 2 }] });
      }),
    );

    const client = new WhoopClient({
      accessToken: "tok",
      refreshToken: "ref",
      userId: 10,
      expiresInSeconds: 3600,
    });
    const cycles = await client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    expect(cycles).toHaveLength(1);
  });

  it("handles wrapped object with 'results' key", async () => {
    cyclesServer.use(
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return HttpResponse.json({ results: [{ id: 3 }] });
      }),
    );

    const client = new WhoopClient({
      accessToken: "tok",
      refreshToken: "ref",
      userId: 10,
      expiresInSeconds: 3600,
    });
    const cycles = await client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    expect(cycles).toHaveLength(1);
  });

  it("returns empty array for unknown object shape", async () => {
    cyclesServer.use(
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return HttpResponse.json({ unknownKey: "value" });
      }),
    );

    const client = new WhoopClient({
      accessToken: "tok",
      refreshToken: "ref",
      userId: 10,
      expiresInSeconds: 3600,
    });
    const cycles = await client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    expect(cycles).toHaveLength(0);
  });

  it("returns empty array for null response", async () => {
    cyclesServer.use(
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return HttpResponse.json(null);
      }),
    );

    const client = new WhoopClient({
      accessToken: "tok",
      refreshToken: "ref",
      userId: 10,
      expiresInSeconds: 3600,
    });
    const cycles = await client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z");
    expect(cycles).toHaveLength(0);
  });
});

describe("WhoopClient — API error handling", () => {
  const apiServer = setupServer();

  beforeAll(() => {
    apiServer.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
  });

  afterEach(() => {
    apiServer.resetHandlers();
  });

  afterAll(() => {
    apiServer.close();
  });

  it("throws on non-200 API response", async () => {
    apiServer.use(
      http.get("https://api.prod.whoop.com/core-details-bff/v0/cycles/details", () => {
        return new HttpResponse("Bad Request", { status: 400 });
      }),
    );

    const client = new WhoopClient({
      accessToken: "tok",
      refreshToken: "ref",
      userId: 10,
      expiresInSeconds: 3600,
    });
    await expect(client.getCycles("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z")).rejects.toThrow(
      /WHOOP API error/,
    );
  });
});
