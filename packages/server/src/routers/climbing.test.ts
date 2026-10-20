import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { ClimbingActivityLogEntry } from "../repositories/climbing-activity-log-entry-repository.ts";
import { ClimbingLogEntryAssociator } from "../repositories/climbing-log-entry-associator.ts";
import { ClimbingRepository } from "../repositories/climbing-repository.ts";
import {
  climbingActivityFixture,
  climbingLogEntryFixture,
} from "../repositories/climbing-test-helpers.ts";
import { HangboardingRepository } from "../repositories/hangboarding-repository.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
const { invalidateByPrefix } = vi.hoisted(() => ({ invalidateByPrefix: vi.fn() }));
const cachedQueryOptions = vi.hoisted((): Array<{ maxAge: number; keyVersion?: string }> => []);

vi.mock("@sentry/node", () => ({ captureException }));
vi.mock("dofek/lib/cache", () => ({ queryCache: { invalidateByPrefix } }));

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

const groupId = "00000000-0000-4000-8000-000000000701";
describe("climbingRouter", () => {
  beforeEach(() => {
    captureException.mockClear();
    invalidateByPrefix.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());
  it.each([
    groupId,
    "00000000-0000-4000-8000-000000000702",
    "00000000-0000-4000-8000-000000000703",
  ])(
    "hydrates canonical climbing logs through the resolved activity group %s",
    async (requestedId) => {
      const activityLookup = vi
        .spyOn(ActivityRepository.prototype, "findById")
        .mockResolvedValue(climbingActivityFixture({ id: groupId }));
      const detail = climbingLogEntryFixture();
      const logLookup = vi
        .spyOn(ClimbingRepository.prototype, "getActivityLogEntries")
        .mockResolvedValue([new ClimbingActivityLogEntry(detail)]);
      const { caller } = makeCaller();
      expect(await caller.activityLogEntries({ activityId: requestedId })).toEqual([detail]);
      expect(activityLookup).toHaveBeenCalledWith(requestedId);
      expect(logLookup).toHaveBeenCalledWith(groupId);
    },
  );
  it("returns NOT_FOUND before reading an unresolved or cross-user activity", async () => {
    vi.spyOn(ActivityRepository.prototype, "findById").mockResolvedValue(null);
    const lookup = vi.spyOn(ClimbingRepository.prototype, "getActivityLogEntries");
    const { caller } = makeCaller();
    await expect(caller.activityLogEntries({ activityId: groupId })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Activity not found",
    });
    expect(lookup).not.toHaveBeenCalled();
  });
  it("serves canonical same-day log suggestions", async () => {
    const detail = climbingLogEntryFixture();
    const lookup = vi
      .spyOn(ClimbingLogEntryAssociator.prototype, "getSuggestions")
      .mockResolvedValue([detail]);
    const { caller } = makeCaller();
    expect(await caller.unattachedClimbingLogEntries({ activityId: groupId })).toEqual([detail]);
    expect(lookup).toHaveBeenCalledWith(groupId);
  });
  it("returns activity attachment choices with their local start times", async () => {
    const options = [
      {
        id: groupId,
        name: "Morning climbing",
        activityType: "climbing",
        providerId: "whoop",
        startTime: "09:16",
      },
    ];
    const { caller } = makeCaller(options);
    expect(await caller.attachmentActivities({ date: "2026-10-04" })).toEqual(options);
  });
  it("rejects invalid attachment dates before querying activities", async () => {
    const { caller, execute } = makeCaller();
    await expect(caller.attachmentActivities({ date: "2026-02-30" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it("reports activity attachment lookup failures with the server error", async () => {
    const { caller, execute } = makeCaller();
    execute.mockRejectedValue(new Error("Activity lookup is unavailable. Try again."));
    await expect(caller.attachmentActivities({ date: "2026-10-04" })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Activity lookup is unavailable. Try again.",
    });
    expect(captureException).toHaveBeenCalled();
  });
  it("attaches a log and invalidates every affected climbing cache", async () => {
    const attach = vi
      .spyOn(ClimbingLogEntryAssociator.prototype, "attachLogEntry")
      .mockResolvedValue(undefined);
    const { caller } = makeCaller();
    const input = { activityId: groupId, climbingLogEntryId: climbingLogEntryFixture().id };
    expect(await caller.attachClimbingLogEntry(input)).toEqual({ attached: true });
    expect(attach).toHaveBeenCalledWith(input);
    for (const procedure of [
      "activityLogEntries",
      "unattachedClimbingLogEntries",
      "gradeProgression",
      "volumeByGrade",
      "sessionSummary",
      "locationMap",
    ])
      expect(invalidateByPrefix).toHaveBeenCalledWith(`user-1:climbing.${procedure}:`);
    expect(invalidateByPrefix).toHaveBeenCalledWith("user-1:activity.list:");
    expect(invalidateByPrefix).toHaveBeenCalledWith("user-1:calendar.weekList:");
  });
  it("returns server-computed volume with the canonical kind", async () => {
    const { caller } = makeCaller([
      {
        climb_kind: "route",
        grade_system: "yds",
        grade: "5.10c",
        attempts: 3,
        recorded_attempts: 3,
        sends: 2,
      },
    ]);
    expect(await caller.volumeByGrade({ days: 90 })).toEqual([
      {
        climbKind: "route",
        gradeSystem: "yds",
        grade: "5.10c",
        gradeSortValue: 64.5,
        attempts: 3,
        recordedAttempts: 3,
        sends: 2,
      },
    ]);
  });
  it("returns server-built map circles with canonical climb details", async () => {
    const { caller } = makeCallerWithResponses([
      [],
      [
        {
          id: "log",
          activity_id: groupId,
          session_date: "2026-10-01",
          climb_name: "Corner",
          title: null,
          provider_id: "openbeta",
          raw: null,
          climb_kind: "route",
          grade_system: "yds",
          grade: "5.10c",
          location: {
            coordinates: { latitude: 0, longitude: -122.25 },
            scope: "area",
            objectId: "area",
            providerId: "openbeta",
            name: "Crag",
          },
        },
      ],
    ]);
    const map = await caller.locationMap({ days: 30, setting: "outdoor" });
    expect(map.bounds).toEqual({ south: 0, north: 0, west: -122.25, east: -122.25 });
    expect(map.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          coordinates: { latitude: 0, longitude: -122.25 },
          count: 1,
          entries: [
            expect.objectContaining({
              id: "log",
              activityId: groupId,
              label: "Corner",
              grade: "5.10c",
            }),
          ],
        }),
      ]),
    );
  });
  it("reports map load errors and preserves the actionable database message", async () => {
    const error = new Error("Climbing database unavailable; retry after sync.");
    const execute = vi.fn().mockRejectedValue(error);
    const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });
    await expect(caller.locationMap({ days: 30 })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: error.message,
    });
    expect(captureException).toHaveBeenCalledWith(error);
  });
  it("returns progression with independently recorded method and solo status", async () => {
    const { caller } = makeCaller([
      {
        session_date: "2026-07-09",
        climb_kind: "route",
        attempt_scope: "climb",
        setting: "indoor",
        grade_system: "yds",
        grade: "5.10a",
        attempt_observations: [
          { ropeMethod: "lead", solo: true, usedAid: false, sends: 1, unknownOutcomes: 0 },
        ],
      },
    ]);
    expect(await caller.gradeProgression({ days: 90 })).toMatchObject([
      {
        climbKind: "route",
        ropeMethod: "lead",
        solo: true,
        usedAid: false,
        periods: [{ settings: [{ sends: 1, climbingDays: 1 }] }],
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
