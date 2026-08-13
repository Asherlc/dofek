import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HangboardingRepository } from "../repositories/hangboarding-repository.ts";
import type {
  ClimbingActivityEntryRow,
  ClimbingGradeProgressionRow,
  ClimbingSessionSummaryRow,
  ClimbingVolumeByGradeRow,
} from "./climbing.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock("@sentry/node", () => ({ captureException }));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (query: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

import { climbingRouter } from "./climbing.ts";

const createCaller = createTestCallerFactory(climbingRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  const caller = createCaller({
    db: { execute },
    userId: "user-1",
    timezone: "America/Los_Angeles",
  });
  return { caller, execute };
}

function makeCallerWithResponses(responses: Record<string, unknown>[][]) {
  const execute = vi.fn();
  for (const response of responses) execute.mockResolvedValueOnce(response);
  execute.mockResolvedValue([]);
  const caller = createCaller({
    db: { execute },
    userId: "user-1",
    timezone: "America/Los_Angeles",
  });
  return { caller, execute };
}

describe("climbingRouter", () => {
  beforeEach(() => {
    captureException.mockClear();
  });

  it("returns activity entry rows", async () => {
    const { caller, execute } = makeCaller([
      {
        id: "entry-1",
        climb_type: "boulder",
        grade_system: "v_scale",
        grade: "v4",
        sent: true,
        attempt_count: 7,
        attempts: [],
        ascent_type: "Redpoint",
        hold_type: null,
        route_name: "Blue Arete",
        location_name: "Pacific Pipe",
        source_name: "Kaya",
        wall_angle_degrees: null,
      },
    ]);

    const result: ClimbingActivityEntryRow[] = await caller.activityEntries({
      id: "734b5d3e-df2b-4ee0-888e-55ea539d913a",
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      {
        id: "entry-1",
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V4",
        sent: true,
        attemptCount: 7,
        attempts: [],
        ascentType: "Redpoint",
        holdType: null,
        routeName: "Blue Arete",
        locationName: "Pacific Pipe",
        sourceName: "Kaya",
        wallAngleDegrees: null,
      },
    ]);
  });

  it("returns grade progression rows", async () => {
    const { caller, execute } = makeCaller([
      {
        session_date: "2026-07-09",
        climb_type: "boulder",
        grade_system: "v_scale",
        grade: "V4",
      },
    ]);

    const result: ClimbingGradeProgressionRow[] = await caller.gradeProgression({ days: 90 });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      {
        date: "2026-07-09",
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V4",
        gradeSortValue: 65,
      },
    ]);
  });

  it("returns volume by grade rows", async () => {
    const { caller, execute } = makeCaller([
      {
        climb_type: "route",
        grade_system: "yds",
        grade: "5.10c",
        attempts: 3,
        sends: 2,
      },
    ]);

    const result: ClimbingVolumeByGradeRow[] = await caller.volumeByGrade({ days: 90 });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      {
        climbType: "route",
        gradeSystem: "yds",
        grade: "5.10c",
        gradeSortValue: 64.5,
        attempts: 3,
        sends: 2,
      },
    ]);
  });

  it("returns session summary rows", async () => {
    const { caller, execute } = makeCaller([
      {
        activity_id: "activity-1",
        session_date: "2026-07-09",
        name: "Kaya climbing at Touchstone Pacific Pipe",
        location_name: "Touchstone Pacific Pipe",
        attempt_count: 9,
        sent: true,
        climb_type: "boulder",
        grade_system: "v_scale",
        grade: "V4",
      },
    ]);

    const result: ClimbingSessionSummaryRow[] = await caller.sessionSummary({ days: 90 });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      {
        activityId: "activity-1",
        date: "2026-07-09",
        name: "Kaya climbing at Touchstone Pacific Pipe",
        locationName: "Touchstone Pacific Pipe",
        attempts: 9,
        sends: 1,
        hardestBoulderGrade: "V4",
        hardestBoulderGradeSortValue: 65,
        hardestRouteGrade: null,
        hardestRouteGradeSortValue: null,
      },
    ]);
  });

  it("returns the Hangboarding summary contract", async () => {
    const { caller, execute } = makeCallerWithResponses([
      [
        {
          session_count: 2,
          total_duration_seconds: 1500,
          average_duration_seconds: 750,
          total_work_duration_seconds: 17,
          total_rest_duration_seconds: 103,
          work_interval_count: 2,
          average_heart_rate: 125,
          peak_heart_rate: 150,
          latest_activity_id: "activity-2",
          latest_started_at: "2026-08-08T14:00:00.000Z",
          latest_plan_name: "Repeaters",
          latest_board_name: "Tension Board",
          latest_duration_seconds: 900,
        },
      ],
      [
        {
          date: "2026-08-07",
          session_count: 1,
          duration_seconds: 600,
          work_duration_seconds: 7,
          rest_duration_seconds: 53,
        },
        {
          date: "2026-08-08",
          session_count: 1,
          duration_seconds: 900,
          work_duration_seconds: 10,
          rest_duration_seconds: 50,
        },
      ],
    ]);

    await expect(caller.hangboardingSummary({ days: 30 })).resolves.toMatchObject({
      sessionCount: 2,
      totalDurationSeconds: 1500,
      averageDurationSeconds: 750,
      totalWorkDurationSeconds: 17,
      totalRestDurationSeconds: 103,
      workIntervalCount: 2,
      averageHeartRate: 125,
      peakHeartRate: 150,
      latestSession: expect.objectContaining({
        activityId: "activity-2",
        durationSeconds: 900,
      }),
      daily: expect.arrayContaining([
        expect.objectContaining({ date: "2026-08-07", durationSeconds: 600 }),
        expect.objectContaining({ date: "2026-08-08", durationSeconds: 900 }),
      ]),
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed hangboarding summary output", async () => {
    const { caller } = makeCaller();
    const getSummary = vi
      .spyOn(HangboardingRepository.prototype, "getSummary")
      .mockResolvedValueOnce({
        averageDurationSeconds: null,
        averageHeartRate: null,
        daily: [],
        latestSession: null,
        peakHeartRate: null,
        sessionCount: 1,
        totalDurationSeconds: 600,
        totalRestDurationSeconds: null,
        totalWorkDurationSeconds: "invalid",
        workIntervalCount: null,
      } as never);

    try {
      await expect(caller.hangboardingSummary({ days: 30 })).rejects.toMatchObject<Partial<TRPCError>>({
        code: "INTERNAL_SERVER_ERROR",
      });
    } finally {
      getSummary.mockRestore();
    }
  });

  it("returns empty arrays when there is no climbing data", async () => {
    const { caller, execute } = makeCaller([]);

    await expect(caller.gradeProgression({ days: 90 })).resolves.toEqual([]);
    await expect(caller.volumeByGrade({ days: 90 })).resolves.toEqual([]);
    await expect(caller.sessionSummary({ days: 90 })).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledTimes(6);
  });

  it("returns a controlled error when climbing data cannot load", async () => {
    const databaseError = new Error("database unavailable");
    const execute = vi.fn().mockRejectedValue(databaseError);
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "America/Los_Angeles",
    });

    await expect(caller.gradeProgression({ days: 90 })).rejects.toMatchObject<Partial<TRPCError>>({
      code: "INTERNAL_SERVER_ERROR",
      message: "database unavailable",
    });
    expect(captureException).toHaveBeenCalledWith(databaseError);
  });

  it("preserves semantic tRPC errors from climbing data helpers", async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(new TRPCError({ code: "PRECONDITION_FAILED", message: "sync first" }));
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "America/Los_Angeles",
    });

    await expect(caller.gradeProgression({ days: 90 })).rejects.toMatchObject<Partial<TRPCError>>({
      code: "PRECONDITION_FAILED",
      message: "sync first",
    });
  });

  it("returns finger-loading history from the training-log repository", async () => {
    const { caller, execute } = makeCaller([
      {
        activity_id: "activity-1",
        bodyweight_kg: 70,
        edge_size_mm: 20,
        exercise: "max_hang",
        external_load_kg: 10,
        grip_position: "half_crimp",
        hold_duration_seconds: 10,
        laterality: "both",
        notes: null,
        rest_interval_seconds: 180,
        rpe: 8,
        set_count: 5,
        started_at: "2026-07-29T12:00:00.000Z",
      },
    ]);

    await expect(caller.fingerLoadingHistory({ days: 30 })).resolves.toEqual([
      expect.objectContaining({
        activityId: "activity-1",
        effectiveLoadKg: 80,
        exercise: "max_hang",
      }),
    ]);
    expect(execute).toHaveBeenCalledOnce();
  });
});
