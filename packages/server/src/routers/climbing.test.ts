import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClimbingActivityEntryRow,
  ClimbingGradeProgressionRow,
  ClimbingSessionSummaryRow,
  ClimbingVolumeByGradeRow,
} from "./climbing.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const { captureException, ensurePushProvider, invalidateAllUserQueries } = vi.hoisted(() => ({
  captureException: vi.fn(),
  ensurePushProvider: vi.fn(),
  invalidateAllUserQueries: vi.fn(),
}));

vi.mock("@sentry/node", () => ({ captureException }));
vi.mock("../repositories/push-provider-repository.ts", () => ({ ensurePushProvider }));
vi.mock("dofek/lib/cache", () => ({ invalidateAllUserQueries }));

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

function makeMutationCaller(error: unknown = new Error("database unavailable")) {
  const execute = vi.fn();
  const transaction = vi.fn().mockRejectedValue(error);
  const caller = createCaller({
    db: { execute, transaction },
    userId: "user-1",
    timezone: "America/Los_Angeles",
  });
  return { caller, execute, transaction };
}

function makeSuccessfulMutationCaller(results: Record<string, unknown>[][]) {
  let resultIndex = 0;
  const execute = vi.fn(async () => results[resultIndex++] ?? []);
  const transactionDatabase = { execute };
  const transaction = vi.fn(
    async (callback: (database: typeof transactionDatabase) => Promise<unknown>) =>
      callback(transactionDatabase),
  );
  const caller = createCaller({
    db: { execute, transaction },
    userId: "user-1",
    timezone: "America/Los_Angeles",
  });
  return { caller, execute, transaction };
}

function makeClimbingSessionInput({
  climbType = "boulder",
  endedAt = null,
  failureReason = null,
  grade,
  gradeSystem = "v_scale",
  outcome = "sent",
}: {
  climbType?: "boulder" | "route";
  endedAt?: string | null;
  failureReason?: "fell" | null;
  grade?: string;
  gradeSystem?:
    | "v_scale"
    | "font"
    | "yds"
    | "french"
    | "uiaa"
    | "ewbank"
    | "saxon"
    | "norwegian"
    | "brazilian_crux";
  outcome?: "failed" | "sent";
} = {}) {
  return {
    climbs: [
      {
        attempts: [{ failureReason, notes: null, outcome }],
        climbType,
        grade: grade ?? (climbType === "boulder" ? "V5" : "5.11a"),
        gradeSystem,
        holdType: "crimp" as const,
        routeName: null,
        wallAngleDegrees: 30,
      },
    ],
    endedAt,
    locationName: null,
    startedAt: "2026-07-29T12:00:00.000Z",
  };
}

describe("climbingRouter", () => {
  beforeEach(() => {
    captureException.mockClear();
    ensurePushProvider.mockReset();
    ensurePushProvider.mockResolvedValue(undefined);
    invalidateAllUserQueries.mockReset();
    invalidateAllUserQueries.mockResolvedValue(undefined);
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

  it("reports repository failures and returns an actionable finger-loading save error", async () => {
    const repositoryError = new Error("database unavailable");
    const { caller } = makeMutationCaller(repositoryError);

    await expect(
      caller.logFingerLoading({
        bodyweightKg: 70,
        edgeSizeMm: 20,
        exercise: "max_hang",
        externalLoadKg: 10,
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
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not save the finger-loading session. Try again.",
    });
    expect(captureException).toHaveBeenCalledWith(repositoryError, {
      tags: { procedure: "climbing.logFingerLoading" },
    });
  });

  it("reports repository failures and returns an actionable climbing-session save error", async () => {
    const repositoryError = new Error("database unavailable");
    const { caller } = makeMutationCaller(repositoryError);

    await expect(
      caller.logClimbingSession({
        climbs: [
          {
            attempts: [{ failureReason: null, notes: null, outcome: "sent" }],
            climbType: "boulder",
            grade: "V5",
            gradeSystem: "v_scale",
            holdType: "crimp",
            routeName: null,
            wallAngleDegrees: 30,
          },
        ],
        endedAt: null,
        locationName: null,
        startedAt: "2026-07-29T12:00:00.000Z",
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not save the climbing session. Try again.",
    });
    expect(captureException).toHaveBeenCalledWith(repositoryError, {
      tags: { procedure: "climbing.logClimbingSession" },
    });
  });

  it("preserves semantic tRPC errors from climbing log repositories", async () => {
    const semanticError = new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Complete setup before logging",
    });
    ensurePushProvider.mockRejectedValueOnce(semanticError);
    const { caller } = makeMutationCaller();

    await expect(
      caller.logFingerLoading({
        bodyweightKg: 70,
        edgeSizeMm: 20,
        exercise: "max_hang",
        externalLoadKg: 10,
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
      code: "PRECONDITION_FAILED",
      message: "Complete setup before logging",
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("returns and invalidates after saving a finger-loading session", async () => {
    const { caller } = makeSuccessfulMutationCaller([
      [{ id: "activity-1" }],
      [],
      [
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
      ],
    ]);

    await expect(
      caller.logFingerLoading({
        bodyweightKg: 70,
        edgeSizeMm: 20,
        exercise: "max_hang",
        externalLoadKg: 10,
        gripPosition: "half_crimp",
        holdDurationSeconds: 10,
        laterality: "both",
        notes: null,
        restIntervalSeconds: 180,
        rpe: 8,
        setCount: 5,
        startedAt: "2026-07-29T12:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      activityId: "activity-1",
      effectiveLoadKg: 80,
    });
    expect(invalidateAllUserQueries).toHaveBeenCalledWith("user-1");
  });

  it("returns and invalidates after saving a climbing session", async () => {
    const { caller } = makeSuccessfulMutationCaller([
      [{ id: "activity-1" }],
      [{ id: "climb-1" }],
      [],
    ]);

    await expect(caller.logClimbingSession(makeClimbingSessionInput())).resolves.toEqual({
      activityId: "activity-1",
      climbs: [{ attemptCount: 1, id: "climb-1", sent: true }],
    });
    expect(invalidateAllUserQueries).toHaveBeenCalledWith("user-1");
  });

  it("enforces climbing attempt outcome and failure-reason pairs", async () => {
    const validSent = makeMutationCaller();
    await expect(
      validSent.caller.logClimbingSession(
        makeClimbingSessionInput({ failureReason: null, outcome: "sent" }),
      ),
    ).rejects.toMatchObject<Partial<TRPCError>>({ code: "INTERNAL_SERVER_ERROR" });

    const invalidSent = makeMutationCaller();
    await expect(
      invalidSent.caller.logClimbingSession(
        makeClimbingSessionInput({ failureReason: "fell", outcome: "sent" }),
      ),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: "BAD_REQUEST",
      message: expect.stringMatching(
        /A sent attempt cannot have a failure reason[\s\S]*failureReason/,
      ),
    });
    expect(invalidSent.execute).not.toHaveBeenCalled();

    const validFailure = makeMutationCaller();
    await expect(
      validFailure.caller.logClimbingSession(
        makeClimbingSessionInput({ failureReason: "fell", outcome: "failed" }),
      ),
    ).rejects.toMatchObject<Partial<TRPCError>>({ code: "INTERNAL_SERVER_ERROR" });

    const invalidFailure = makeMutationCaller();
    await expect(
      invalidFailure.caller.logClimbingSession(
        makeClimbingSessionInput({ failureReason: null, outcome: "failed" }),
      ),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: "BAD_REQUEST",
      message: expect.stringMatching(
        /A failed attempt requires a failure reason[\s\S]*failureReason/,
      ),
    });
    expect(invalidFailure.execute).not.toHaveBeenCalled();
  });

  it("accepts matching climbing grade systems and rejects both mismatches", async () => {
    const validBoulder = makeMutationCaller();
    await expect(
      validBoulder.caller.logClimbingSession(
        makeClimbingSessionInput({ climbType: "boulder", gradeSystem: "v_scale" }),
      ),
    ).rejects.toMatchObject<Partial<TRPCError>>({ code: "INTERNAL_SERVER_ERROR" });

    const validRoute = makeMutationCaller();
    await expect(
      validRoute.caller.logClimbingSession(
        makeClimbingSessionInput({ climbType: "route", gradeSystem: "yds" }),
      ),
    ).rejects.toMatchObject<Partial<TRPCError>>({ code: "INTERNAL_SERVER_ERROR" });

    const validFont = makeMutationCaller();
    await expect(
      validFont.caller.logClimbingSession(
        makeClimbingSessionInput({ climbType: "boulder", grade: "6a", gradeSystem: "font" }),
      ),
    ).rejects.toMatchObject<Partial<TRPCError>>({ code: "INTERNAL_SERVER_ERROR" });

    const invalidGrade = makeMutationCaller();
    await expect(
      invalidGrade.caller.logClimbingSession(
        makeClimbingSessionInput({ climbType: "boulder", grade: "V4", gradeSystem: "font" }),
      ),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: "BAD_REQUEST",
    });
    expect(invalidGrade.execute).not.toHaveBeenCalled();

    for (const [climbType, gradeSystem] of [
      ["boulder", "yds"],
      ["route", "v_scale"],
    ] as const) {
      const invalid = makeMutationCaller();
      await expect(
        invalid.caller.logClimbingSession(makeClimbingSessionInput({ climbType, gradeSystem })),
      ).rejects.toMatchObject<Partial<TRPCError>>({
        code: "BAD_REQUEST",
        message: expect.stringContaining("Grade system must match the climb type"),
      });
      expect(invalid.execute).not.toHaveBeenCalled();
    }
  });

  it("accepts null, equal, and later session ends but rejects an earlier end", async () => {
    for (const endedAt of [null, "2026-07-29T12:00:00.000Z", "2026-07-29T13:00:00.000Z"]) {
      const valid = makeMutationCaller();
      await expect(
        valid.caller.logClimbingSession(makeClimbingSessionInput({ endedAt })),
      ).rejects.toMatchObject<Partial<TRPCError>>({ code: "INTERNAL_SERVER_ERROR" });
    }

    const invalid = makeMutationCaller();
    await expect(
      invalid.caller.logClimbingSession(
        makeClimbingSessionInput({ endedAt: "2026-07-29T11:59:59.999Z" }),
      ),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Session end time cannot be before its start time"),
    });
  });
});
