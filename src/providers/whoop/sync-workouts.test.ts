import { WhoopClient } from "@dofek/whoop/client";
import type { WhoopWeightliftingWorkoutResponse, WhoopWorkoutRecord } from "@dofek/whoop/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../../db/index.ts";
import { SyncWindow } from "../sync-window.ts";
import type { WhoopSyncContext } from "./sync-types.ts";
import {
  fetchWhoopDeveloperWorkoutsPage,
  persistWhoopWorkoutsFromCycles,
  syncWhoopStrengthForActivity,
  syncWhoopWorkouts,
} from "./sync-workouts.ts";

const providerActivityAbsenceMocks = vi.hoisted(() => ({
  finishProviderActivityListSync: vi.fn().mockResolvedValue(undefined),
  upsertProviderActivity: vi.fn().mockResolvedValue(undefined),
}));

const exerciseProvenanceMocks = vi.hoisted(() => ({
  resolveUserExerciseWithProvenance: vi.fn().mockResolvedValue("exercise-1"),
}));

const syncLogMocks = vi.hoisted(() => ({
  withSyncLog: vi.fn(
    async (
      _db: unknown,
      _providerId: string,
      _dataType: string,
      callback: () => Promise<{ result: number }>,
    ) => (await callback()).result,
  ),
}));

vi.mock("../../db/provider-activity-sync.ts", () => ({
  finishProviderActivityListSync: providerActivityAbsenceMocks.finishProviderActivityListSync,
  upsertProviderActivity: providerActivityAbsenceMocks.upsertProviderActivity,
}));

vi.mock("../../db/exercise-provenance.ts", () => ({
  resolveUserExerciseWithProvenance: exerciseProvenanceMocks.resolveUserExerciseWithProvenance,
}));

vi.mock("../../db/sync-log.ts", () => ({ withSyncLog: syncLogMocks.withSyncLog }));

function makeDb(selectedRows: unknown[] = []) {
  const chain = {
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    onConflictDoNothing: vi.fn(),
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  };

  chain.values.mockReturnValue(chain);
  chain.onConflictDoUpdate.mockResolvedValue(undefined);
  chain.onConflictDoNothing.mockResolvedValue(undefined);
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(
    Object.assign(Promise.resolve(selectedRows), {
      limit: vi.fn().mockResolvedValue(selectedRows),
    }),
  );
  chain.limit.mockResolvedValue(selectedRows);

  const db: SyncDatabase = {
    insert: vi.fn().mockReturnValue(chain),
    select: vi.fn().mockReturnValue(chain),
    delete: vi.fn().mockReturnValue(chain),
    execute: vi.fn().mockResolvedValue([]),
  };

  return { db, chain, delete: db.delete, insert: db.insert };
}

function makeClient() {
  return new WhoopClient({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    userId: 123,
    expiresInSeconds: 3600,
  });
}

function makeWorkoutRecord(
  overrides: Partial<{
    activity_id: string | undefined;
    during: string;
    timezone_offset: string;
  }> = {},
): WhoopWorkoutRecord {
  return {
    activity_id: "workout-1",
    during: "['2026-05-01T10:00:00Z','2026-05-01T11:00:00Z')",
    sport_id: 0,
    average_heart_rate: 155,
    max_heart_rate: 185,
    kilojoules: 2500.5,
    score: 12.5,
    timezone_offset: "Z",
    ...overrides,
  };
}

function makeWeightliftingData(
  overrides: Partial<WhoopWeightliftingWorkoutResponse> = {},
): WhoopWeightliftingWorkoutResponse {
  return {
    activity_id: "workout-1",
    user_id: 123,
    during: "['2026-05-01T10:00:00Z','2026-05-01T11:00:00Z')",
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
                during: "['2026-05-01T10:05:00Z','2026-05-01T10:05:30Z')",
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
    ...overrides,
  };
}

function makeContext(overrides: Partial<WhoopSyncContext> = {}): WhoopSyncContext {
  const { db } = makeDb();
  return {
    db,
    client: makeClient(),
    cycles: [],
    providerId: "whoop",
    since: new Date("2026-05-01T00:00:00.000Z"),
    windowEnd: new Date("2026-05-03T00:00:00.000Z"),
    options: { userId: "user-1" },
    errors: [],
    ...overrides,
  };
}

beforeEach(() => {
  providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
  providerActivityAbsenceMocks.upsertProviderActivity.mockClear();
  providerActivityAbsenceMocks.upsertProviderActivity.mockResolvedValue(undefined);
  exerciseProvenanceMocks.resolveUserExerciseWithProvenance.mockClear();
  exerciseProvenanceMocks.resolveUserExerciseWithProvenance.mockResolvedValue("exercise-1");
  syncLogMocks.withSyncLog.mockClear();
});

describe("WHOOP workout sync helpers", () => {
  it("filters developer workout pages to the absence reconciliation window", async () => {
    const client = makeClient();
    vi.spyOn(client, "listDeveloperWorkouts").mockResolvedValue({
      records: [
        { id: "inside-window", start: "2026-05-01T12:00:00.000Z", end: "2026-05-01T13:00:00.000Z" },
        {
          id: "outside-window",
          start: "2026-05-10T12:00:00.000Z",
          end: "2026-05-10T13:00:00.000Z",
        },
        { id: "", start: "2026-05-01T14:00:00.000Z", end: "2026-05-01T15:00:00.000Z" },
        { id: "invalid-start", start: "not-a-date", end: "2026-05-01T15:00:00.000Z" },
      ],
      next_token: "page-2",
    });
    const absenceWindow = new SyncWindow({
      since: new Date("2026-05-01T00:00:00.000Z"),
      until: new Date("2026-05-03T00:00:00.000Z"),
    });
    const context = makeContext({ client });

    await expect(
      fetchWhoopDeveloperWorkoutsPage(context, absenceWindow, "page-1"),
    ).resolves.toEqual({
      presentIds: ["inside-window"],
      nextToken: "page-2",
      reachedWindowStart: false,
    });
  });

  it("marks developer workout pagination as reaching the window start", async () => {
    const client = makeClient();
    vi.spyOn(client, "listDeveloperWorkouts").mockResolvedValue({
      records: [
        { id: "older-workout", start: "2026-04-20T12:00:00.000Z", end: "2026-04-20T13:00:00.000Z" },
      ],
      next_token: null,
    });
    const absenceWindow = new SyncWindow({
      since: new Date("2026-05-01T00:00:00.000Z"),
      until: new Date("2026-05-03T00:00:00.000Z"),
    });
    const context = makeContext({ client });

    await expect(fetchWhoopDeveloperWorkoutsPage(context, absenceWindow)).resolves.toEqual({
      presentIds: [],
      nextToken: null,
      reachedWindowStart: true,
    });
  });

  it("records workout persistence errors without aborting the batch", async () => {
    const upsertError = new Error("database unavailable");
    providerActivityAbsenceMocks.upsertProviderActivity.mockRejectedValueOnce(upsertError);
    const context = makeContext({
      cycles: [{ workouts: [makeWorkoutRecord({ activity_id: "broken-workout" })] }],
    });

    await expect(
      persistWhoopWorkoutsFromCycles(context, new Set(["broken-workout"])),
    ).resolves.toBe(0);
    expect(context.errors).toEqual([
      {
        message: "Workout broken-workout: database unavailable",
        externalId: "broken-workout",
        cause: upsertError,
      },
    ]);
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalled();
  });

  it("skips workouts that cannot be parsed when persisting provider activities", async () => {
    const context = makeContext({
      cycles: [{ workouts: [makeWorkoutRecord({ activity_id: undefined })] }],
    });

    await expect(persistWhoopWorkoutsFromCycles(context, new Set())).resolves.toBe(0);
    expect(providerActivityAbsenceMocks.upsertProviderActivity).not.toHaveBeenCalled();
    expect(context.errors).toEqual([]);
  });

  it.each([
    [
      "-08:00",
      {
        timezone: null,
        startUtcOffsetMinutes: -480,
        endUtcOffsetMinutes: -480,
        localTimeSource: "provider_offset",
      },
    ],
    [
      "not-an-offset",
      {
        timezone: null,
        startUtcOffsetMinutes: null,
        endUtcOffsetMinutes: null,
        localTimeSource: "unknown",
      },
    ],
  ])(
    "persists WHOOP local-time context from timezone offset %s",
    async (timezoneOffset, expected) => {
      const context = makeContext({
        cycles: [{ workouts: [makeWorkoutRecord({ timezone_offset: timezoneOffset })] }],
      });

      await expect(persistWhoopWorkoutsFromCycles(context, new Set(["workout-1"]))).resolves.toBe(
        1,
      );
      expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledWith(
        context.db,
        expect.objectContaining(expected),
        expect.objectContaining(expected),
      );
    },
  );

  it("records parse failures while persisting provider activities", async () => {
    const context = makeContext({
      cycles: [{ workouts: [makeWorkoutRecord({ during: "invalid-range" })] }],
    });

    await expect(persistWhoopWorkoutsFromCycles(context, new Set(["workout-1"]))).resolves.toBe(0);
    expect(context.errors[0]?.externalId).toBe("workout-1");
    expect(context.errors[0]?.message).toContain("invalid-range");
  });

  it("reconciles the developer workout window after persisting workouts", async () => {
    const client = makeClient();
    const presentExternalIds = new Set(["workout-1"]);
    vi.spyOn(client, "listDeveloperWorkoutIdsInWindow").mockResolvedValue(presentExternalIds);
    const context = makeContext({
      client,
      cycles: [{ workouts: [makeWorkoutRecord()] }],
    });

    await expect(syncWhoopWorkouts(context)).resolves.toBe(1);
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledOnce();
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      context.db,
      expect.objectContaining({ providerId: "whoop", presentExternalIds }),
    );
  });

  it("records developer reconciliation failures while preserving workout persistence", async () => {
    const client = makeClient();
    vi.spyOn(client, "listDeveloperWorkoutIdsInWindow").mockRejectedValue(
      new Error("Developer workouts unavailable"),
    );
    const context = makeContext({
      client,
      cycles: [{ workouts: [makeWorkoutRecord()] }],
    });

    await expect(syncWhoopWorkouts(context)).resolves.toBe(1);
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledOnce();
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).not.toHaveBeenCalled();
    expect(context.errors).toEqual([
      expect.objectContaining({ message: "developer workouts: Developer workouts unavailable" }),
    ]);
  });

  it("syncWhoopStrengthForActivity returns 0 when the workout is missing from cycles", async () => {
    const client = makeClient();
    vi.spyOn(client, "getWeightliftingWorkout");
    const context = makeContext({ client, cycles: [] });

    await expect(syncWhoopStrengthForActivity(context, "missing-workout")).resolves.toBe(0);
    expect(client.getWeightliftingWorkout).not.toHaveBeenCalled();
  });

  it("syncWhoopStrengthForActivity returns 0 when weightlifting data is unavailable", async () => {
    const client = makeClient();
    vi.spyOn(client, "getWeightliftingWorkout").mockResolvedValue(null);
    const context = makeContext({
      client,
      cycles: [{ workouts: [makeWorkoutRecord({ activity_id: "workout-1" })] }],
    });

    await expect(syncWhoopStrengthForActivity(context, "workout-1")).resolves.toBe(0);
  });

  it("syncWhoopStrengthForActivity returns 0 when the payload has no exercises", async () => {
    const client = makeClient();
    vi.spyOn(client, "getWeightliftingWorkout").mockResolvedValue(
      makeWeightliftingData({ workout_groups: [] }),
    );
    const context = makeContext({
      client,
      cycles: [{ workouts: [makeWorkoutRecord({ activity_id: "workout-1" })] }],
    });

    await expect(syncWhoopStrengthForActivity(context, "workout-1")).resolves.toBe(0);
  });

  it("syncWhoopStrengthForActivity returns 0 when no workout duration can be resolved", async () => {
    const client = makeClient();
    vi.spyOn(client, "getWeightliftingWorkout").mockResolvedValue(
      makeWeightliftingData({ during: undefined }),
    );
    const context = makeContext({
      client,
      cycles: [{ workouts: [makeWorkoutRecord({ activity_id: "workout-1", during: undefined })] }],
    });

    await expect(syncWhoopStrengthForActivity(context, "workout-1")).resolves.toBe(0);
  });

  it("syncWhoopStrengthForActivity returns 0 when the activity row has no id", async () => {
    const client = makeClient();
    vi.spyOn(client, "getWeightliftingWorkout").mockResolvedValue(makeWeightliftingData());
    providerActivityAbsenceMocks.upsertProviderActivity.mockResolvedValue(undefined);
    const context = makeContext({
      client,
      cycles: [{ workouts: [makeWorkoutRecord({ activity_id: "workout-1" })] }],
    });

    await expect(syncWhoopStrengthForActivity(context, "workout-1")).resolves.toBe(0);
    expect(context.errors).toEqual([]);
  });

  it("syncWhoopStrengthForActivity falls back to the cycle workout duration", async () => {
    const db = makeDb([{ id: "exercise-1" }]);
    const client = makeClient();
    vi.spyOn(client, "getWeightliftingWorkout").mockResolvedValue(
      makeWeightliftingData({ during: undefined }),
    );
    providerActivityAbsenceMocks.upsertProviderActivity.mockResolvedValue({ id: "activity-1" });
    const context = makeContext({
      db: db.db,
      client,
      cycles: [{ workouts: [makeWorkoutRecord({ activity_id: "workout-1" })] }],
    });

    await expect(syncWhoopStrengthForActivity(context, "workout-1")).resolves.toBe(1);
  });

  it("syncWhoopStrengthForActivity persists sets for the matching activity id", async () => {
    const db = makeDb([{ id: "exercise-1" }]);
    const client = makeClient();
    vi.spyOn(client, "getWeightliftingWorkout").mockResolvedValue(makeWeightliftingData());
    providerActivityAbsenceMocks.upsertProviderActivity.mockResolvedValue({ id: "activity-1" });
    const context = makeContext({
      db: db.db,
      client,
      cycles: [
        { workouts: [makeWorkoutRecord({ activity_id: "workout-1" })] },
        { workouts: [makeWorkoutRecord({ activity_id: "other-workout" })] },
      ],
    });

    await expect(syncWhoopStrengthForActivity(context, "workout-1")).resolves.toBe(1);
    expect(exerciseProvenanceMocks.resolveUserExerciseWithProvenance).toHaveBeenCalledWith(
      db.db,
      expect.objectContaining({
        providerExerciseId: "BENCHPRESS",
        providerId: "whoop",
        userId: "user-1",
      }),
    );
    expect(db.delete).toHaveBeenCalled();
    expect(db.chain.values).toHaveBeenCalledWith([
      expect.objectContaining({
        activityId: "activity-1",
        exerciseId: "exercise-1",
        weightKg: 60,
        reps: 10,
      }),
    ]);
  });
});
