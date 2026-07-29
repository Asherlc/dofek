import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import type {
  ClimbingActivityEntryRow,
  ClimbingGradeProgressionRow,
  ClimbingSessionSummaryRow,
  ClimbingVolumeByGradeRow,
} from "./climbing.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

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

describe("climbingRouter", () => {
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

    expect(execute).toHaveBeenCalledTimes(1);
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
        grade_sort_value: 4,
      },
    ]);

    const result: ClimbingGradeProgressionRow[] = await caller.gradeProgression({ days: 90 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        date: "2026-07-09",
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V4",
        gradeSortValue: 4,
      },
    ]);
  });

  it("returns volume by grade rows", async () => {
    const { caller, execute } = makeCaller([
      {
        climb_type: "route",
        grade_system: "yds",
        grade: "5.10c",
        grade_sort_value: 5103,
        attempts: 3,
        sends: 2,
      },
    ]);

    const result: ClimbingVolumeByGradeRow[] = await caller.volumeByGrade({ days: 90 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        climbType: "route",
        gradeSystem: "yds",
        grade: "5.10c",
        gradeSortValue: 5103,
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
        attempts: 9,
        sends: 6,
        hardest_boulder_grade: "V4",
        hardest_boulder_grade_sort_value: 4,
        hardest_route_grade: null,
        hardest_route_grade_sort_value: null,
      },
    ]);

    const result: ClimbingSessionSummaryRow[] = await caller.sessionSummary({ days: 90 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        activityId: "activity-1",
        date: "2026-07-09",
        name: "Kaya climbing at Touchstone Pacific Pipe",
        locationName: "Touchstone Pacific Pipe",
        attempts: 9,
        sends: 6,
        hardestBoulderGrade: "V4",
        hardestBoulderGradeSortValue: 4,
        hardestRouteGrade: null,
        hardestRouteGradeSortValue: null,
      },
    ]);
  });

  it("returns empty arrays when there is no climbing data", async () => {
    const { caller, execute } = makeCaller([]);

    await expect(caller.gradeProgression({ days: 90 })).resolves.toEqual([]);
    await expect(caller.volumeByGrade({ days: 90 })).resolves.toEqual([]);
    await expect(caller.sessionSummary({ days: 90 })).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("returns a controlled error when climbing data cannot load", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "America/Los_Angeles",
    });

    await expect(caller.gradeProgression({ days: 90 })).rejects.toMatchObject<Partial<TRPCError>>({
      code: "INTERNAL_SERVER_ERROR",
      message: "database unavailable",
    });
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

  it("rejects a finger-loading protocol with a non-positive effective load", async () => {
    const { caller, execute } = makeCaller();

    await expect(
      caller.logFingerLoading({
        bodyweightKg: 70,
        edgeSizeMm: 20,
        exercise: "max_hang",
        externalLoadKg: -70,
        gripPosition: "half_crimp",
        holdDurationSeconds: 10,
        laterality: "both",
        notes: null,
        restIntervalSeconds: 180,
        rpe: 8,
        setCount: 5,
        startedAt: "2026-07-29T12:00:00.000Z",
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: "BAD_REQUEST",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects inconsistent climbing grade systems and session timestamps", async () => {
    const { caller, execute } = makeCaller();

    await expect(
      caller.logClimbingSession({
        climbs: [
          {
            attempts: [{ failureReason: null, notes: null, outcome: "sent" }],
            climbType: "boulder",
            grade: "V5",
            gradeSystem: "yds",
            holdType: "crimp",
            routeName: null,
            wallAngleDegrees: 30,
          },
        ],
        endedAt: "2026-07-29T11:00:00.000Z",
        locationName: null,
        startedAt: "2026-07-29T12:00:00.000Z",
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: "BAD_REQUEST",
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
