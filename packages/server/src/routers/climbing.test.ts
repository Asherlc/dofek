import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityRow } from "../models/activity.ts";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { ClimbingActivityEntry, ClimbingRepository } from "../repositories/climbing-repository.ts";
import { HangboardingRepository } from "../repositories/hangboarding-repository.ts";
import type {
  ClimbingActivityEntryRow,
  ClimbingGradeProgressionRow,
  ClimbingSessionSummaryRow,
  ClimbingVolumeByGradeRow,
} from "./climbing.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
const cachedQueryOptions = vi.hoisted((): Array<{ maxAge: number; keyVersion?: string }> => []);

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
    cachedProtectedQuery: (options: { maxAge: number; keyVersion?: string }) => {
      cachedQueryOptions.push(options);
      return trpc.procedure;
    },
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

function makeResolvedActivity(id: string, resolvedFrom?: string): ActivityRow {
  return {
    absent_source_external_ids: null,
    avg_cadence: null,
    avg_hr: null,
    avg_power: null,
    avg_speed: null,
    canonical_type: "climbing",
    elevation_gain_m: null,
    elevation_loss_m: null,
    ended_at: "2026-09-01T11:00:00.000Z",
    end_utc_offset_minutes: 0,
    id,
    local_time_source: "provider_timezone",
    max_hr: null,
    max_power: null,
    max_speed: null,
    modality: null,
    name: "Climbing",
    notes: null,
    perceived_exertion: null,
    provider_absent_at: null,
    provider_id: "kaya",
    raw_type: "climbing",
    resolved_from: resolvedFrom,
    sample_count: null,
    source_external_ids: [],
    source_providers: ["kaya"],
    start_utc_offset_minutes: 0,
    started_at: "2026-09-01T10:00:00.000Z",
    subsource: null,
    timezone: "UTC",
    total_distance: null,
  };
}

describe("climbingRouter", () => {
  beforeEach(() => {
    captureException.mockClear();
  });

  it("returns activity entry rows", async () => {
    const activityLookup = vi
      .spyOn(ActivityRepository.prototype, "findById")
      .mockResolvedValue(makeResolvedActivity("734b5d3e-df2b-4ee0-888e-55ea539d913a"));
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

    try {
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
      expect(cachedQueryOptions).toContainEqual({
        maxAge: 3_600_000,
        keyVersion: "climbing-activity-group-v1",
      });
    } finally {
      activityLookup.mockRestore();
    }
  });

  it.each([
    ["stable group", "00000000-0000-4000-8000-000000000701", undefined],
    ["member", "00000000-0000-4000-8000-000000000702", "00000000-0000-4000-8000-000000000702"],
    ["merge alias", "00000000-0000-4000-8000-000000000703", "00000000-0000-4000-8000-000000000703"],
  ] as const)(
    "hydrates %s requests through the resolved stable group",
    async (_, requestedId, resolvedFrom) => {
      const stableGroupId = "00000000-0000-4000-8000-000000000701";
      const activityLookup = vi
        .spyOn(ActivityRepository.prototype, "findById")
        .mockResolvedValue(makeResolvedActivity(stableGroupId, resolvedFrom));
      const climbingLookup = vi
        .spyOn(ClimbingRepository.prototype, "getActivityEntries")
        .mockResolvedValue([
          new ClimbingActivityEntry({
            ascentType: "Redpoint",
            attemptCount: 1,
            attempts: [],
            climbType: "boulder",
            grade: "V4",
            gradeSystem: "v_scale",
            holdType: null,
            id: "entry-1",
            lead: null,
            locationName: "Pacific Pipe",
            routeName: "Blue Arete",
            sent: true,
            sourceName: "Kaya",
            wallAngleDegrees: null,
          }),
        ]);
      const { caller } = makeCaller([]);

      try {
        await expect(caller.activityEntries({ id: requestedId })).resolves.toEqual([
          expect.objectContaining({ id: "entry-1", routeName: "Blue Arete" }),
        ]);
        expect(activityLookup).toHaveBeenCalledWith(requestedId);
        expect(climbingLookup).toHaveBeenCalledWith(stableGroupId);
      } finally {
        activityLookup.mockRestore();
        climbingLookup.mockRestore();
      }
    },
  );

  it("returns the same NOT_FOUND response for unresolved or cross-user climbing IDs", async () => {
    const activityLookup = vi
      .spyOn(ActivityRepository.prototype, "findById")
      .mockResolvedValue(null);
    const climbingLookup = vi.spyOn(ClimbingRepository.prototype, "getActivityEntries");
    const { caller } = makeCaller([]);

    try {
      await expect(
        caller.activityEntries({ id: "00000000-0000-4000-8000-000000000704" }),
      ).rejects.toMatchObject<Partial<TRPCError>>({
        code: "NOT_FOUND",
        message: "Activity not found",
      });
      expect(climbingLookup).not.toHaveBeenCalled();
    } finally {
      activityLookup.mockRestore();
      climbingLookup.mockRestore();
    }
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
        totalWorkDurationSeconds: Number.NaN,
        workIntervalCount: null,
      });

    try {
      await expect(caller.hangboardingSummary({ days: 30 })).rejects.toMatchObject<
        Partial<TRPCError>
      >({
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
