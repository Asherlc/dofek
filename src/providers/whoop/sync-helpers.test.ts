import { beforeEach, describe, expect, it, vi } from "vitest";
import { WhoopClient } from "whoop-whoop/client";
import type { WhoopCycle, WhoopWorkoutRecord } from "whoop-whoop/types";
import type { SyncDatabase } from "../../db/index.ts";
import { writeMetricStreamBatch } from "../../db/metric-stream-writer.ts";
import { SOURCE_TYPE_API } from "../../db/sensor-channels.ts";
import { SyncWindow } from "../sync-window.ts";
import { syncWhoopDailyActivity } from "./sync-daily-activity.ts";
import { syncWhoopSleepSessions, syncWhoopSleepStages } from "./sync-sleep.ts";
import { syncWhoopHeartRateStream } from "./sync-streams.ts";
import type { WhoopSyncContext } from "./sync-types.ts";
import { syncWhoopWorkouts } from "./sync-workouts.ts";

const providerActivityAbsenceMocks = vi.hoisted(() => ({
  reconcileProviderActivityAbsence: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../db/provider-activity-absence.ts", () => ({
  reconcileProviderActivityAbsence: providerActivityAbsenceMocks.reconcileProviderActivityAbsence,
}));

vi.mock("../../db/sync-log.ts", () => ({
  withSyncLog: vi.fn(
    async (
      _db: unknown,
      _providerId: string,
      _dataType: string,
      callback: () => Promise<{ recordCount: number; result: number }>,
    ) => {
      const result = await callback();
      return result.result;
    },
  ),
}));

vi.mock("../../db/metric-stream-writer.ts", () => ({
  writeMetricStreamBatch: vi.fn().mockResolvedValue(undefined),
}));

function makeDb(selectedRows: unknown[] = []) {
  const chain = {
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  };

  chain.values.mockReturnValue(chain);
  chain.onConflictDoUpdate.mockResolvedValue(undefined);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockResolvedValue(selectedRows);

  const db: SyncDatabase = {
    insert: vi.fn().mockReturnValue(chain),
    select: vi.fn().mockReturnValue(chain),
    delete: vi.fn().mockReturnValue(chain),
    execute: vi.fn().mockResolvedValue([]),
  };

  return { db, chain, insert: db.insert, select: db.select };
}

function makeClient() {
  return new WhoopClient({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    userId: 123,
  });
}

function makeContext(overrides: Partial<WhoopSyncContext> = {}): WhoopSyncContext {
  const { db } = makeDb();
  return {
    db,
    client: makeClient(),
    cycles: [],
    providerId: "whoop",
    since: new Date("2026-05-01T00:00:00.000Z"),
    windowEnd: new Date("2026-05-02T00:00:00.000Z"),
    options: { userId: "user-1" },
    errors: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-09T00:00:00.000Z"));
  vi.mocked(writeMetricStreamBatch).mockClear();
  providerActivityAbsenceMocks.reconcileProviderActivityAbsence.mockClear();
});

function makeWorkoutRecord(
  overrides: Partial<{
    activity_id: string | undefined;
    during: string;
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

function makeWorkoutRecordWithRawActivityId(activityId: unknown): WhoopWorkoutRecord {
  const record = makeWorkoutRecord();
  Object.defineProperty(record, "activity_id", {
    value: activityId,
    enumerable: true,
  });
  return record;
}

describe("WHOOP sync helpers", () => {
  it("syncs daily activity from strain deep-dive steps per date", async () => {
    const db = makeDb();
    const client = makeClient();
    const getStrainDeepDive = vi
      .spyOn(client, "getStrainDeepDive")
      .mockImplementation(async (date: string) => {
        const stepsByDate: Record<string, number> = {
          "2026-05-01": 1800,
          "2026-05-02": 1000,
        };
        const steps = stepsByDate[date];
        if (steps == null) {
          return { sections: [] };
        }
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
      });
    const context = makeContext({ db: db.db, client });

    const result = await syncWhoopDailyActivity(context);

    expect(result).toEqual({ count: 2, rateLimited: false });
    expect(getStrainDeepDive).toHaveBeenCalledWith("2026-05-01");
    expect(getStrainDeepDive).toHaveBeenCalledWith("2026-05-09");
    expect(db.chain.values).toHaveBeenCalledWith({
      date: "2026-05-01",
      providerId: "whoop",
      steps: 1800,
    });
    expect(db.chain.values).toHaveBeenCalledWith({
      date: "2026-05-02",
      providerId: "whoop",
      steps: 1000,
    });
  });

  it("skips days without steps in the strain deep-dive response", async () => {
    const client = makeClient();
    vi.spyOn(client, "getStrainDeepDive").mockResolvedValue({ sections: [] });
    const context = makeContext({ client });

    await expect(syncWhoopDailyActivity(context)).resolves.toEqual({
      count: 0,
      rateLimited: false,
    });
    expect(context.errors).toEqual([]);
  });

  it("records daily activity errors without failing the whole provider sync", async () => {
    const client = makeClient();
    vi.spyOn(client, "getStrainDeepDive").mockRejectedValue(new Error("network down"));
    const context = makeContext({ client });

    await expect(syncWhoopDailyActivity(context)).resolves.toEqual({
      count: 0,
      rateLimited: false,
    });
    expect(context.errors[0]?.message).toBe("daily_activity: network down");
  });

  it("writes parsed heart-rate stream rows in weekly windows", async () => {
    const client = makeClient();
    vi.spyOn(client, "getHeartRate").mockResolvedValue([
      { time: Date.parse("2026-05-01T00:00:00.000Z"), data: 61 },
      { time: Date.parse("2026-05-01T00:00:06.000Z"), data: 63 },
    ]);
    const context = makeContext({ client });

    const result = await syncWhoopHeartRateStream(context);

    expect(result).toEqual({ count: 4, rateLimited: false });
    expect(writeMetricStreamBatch).toHaveBeenCalledWith(
      context.db,
      [
        { providerId: "whoop", recordedAt: new Date("2026-05-01T00:00:00.000Z"), heartRate: 61 },
        { providerId: "whoop", recordedAt: new Date("2026-05-01T00:00:06.000Z"), heartRate: 63 },
      ],
      SOURCE_TYPE_API,
      undefined,
      undefined,
    );
  });

  it("records heart-rate stream errors and marks them non-rate-limited", async () => {
    const client = makeClient();
    vi.spyOn(client, "getHeartRate").mockRejectedValue("offline");
    const context = makeContext({ client });

    await expect(syncWhoopHeartRateStream(context)).resolves.toEqual({
      count: 0,
      rateLimited: false,
    });
    expect(context.errors[0]?.message).toBe("hr_stream: offline");
  });

  it("syncs complete inline sleep sessions and skips invalid or incomplete rows", async () => {
    const db = makeDb();
    const cycles: WhoopCycle[] = [
      {
        sleeps: [
          {
            during: "['2026-05-01T04:00:00Z','2026-05-01T12:00:00Z')",
            state: "complete",
            time_in_bed: 28_800_000,
            wake_duration: 1_800_000,
            light_sleep_duration: 12_000_000,
            slow_wave_sleep_duration: 6_000_000,
            rem_sleep_duration: 7_200_000,
            in_sleep_efficiency: 0.875,
            habitual_sleep_need: 28_800_000,
            debt_post: 600_000,
            need_from_strain: 900_000,
            credit_from_naps: 300_000,
          },
          {
            during: "['2026-05-02T04:00:00Z','2026-05-02T05:00:00Z')",
            state: "pending",
            time_in_bed: 3_600_000,
            wake_duration: 0,
            light_sleep_duration: 3_600_000,
            slow_wave_sleep_duration: 0,
            rem_sleep_duration: 0,
          },
          { during: "bad" },
        ],
      },
    ];
    const context = makeContext({ db: db.db, cycles });

    await expect(syncWhoopSleepSessions(context)).resolves.toBe(1);
    expect(db.chain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "whoop",
        externalId: "inline-2026-05-01T04:00:00.000Z-0",
        durationMinutes: 450,
        efficiencyPct: 87.5,
        sleepNeedBaselineMinutes: 480,
      }),
    );
  });

  it("persists sleep stages when a matching session exists", async () => {
    const db = makeDb([{ id: "session-1" }]);
    const client = makeClient();
    const getSleep = vi.spyOn(client, "getSleep").mockResolvedValue({
      id: 123,
      user_id: 123,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      timezone_offset: "Z",
      nap: false,
      stages: [
        { stage: "slow_wave", during: "['2026-05-01T04:00:00Z','2026-05-01T05:00:00Z')" },
        { stage: "rem", during: "['2026-05-01T05:00:00Z','2026-05-01T06:00:00Z')" },
        { stage: "unknown", during: "['2026-05-01T06:00:00Z','2026-05-01T07:00:00Z')" },
      ],
    });
    const cycles: WhoopCycle[] = [
      {
        sleep: { id: 123 },
        recovery: {
          sleep_id: 123,
          user_id: 123,
          created_at: "2026-05-01T00:00:00.000Z",
          updated_at: "2026-05-01T00:00:00.000Z",
        },
      },
    ];
    const context = makeContext({
      db: db.db,
      client,
      cycles,
    });

    await expect(syncWhoopSleepStages(context)).resolves.toBe(1);
    expect(getSleep).toHaveBeenCalledWith("123");
    expect(db.chain.values).toHaveBeenCalledWith([
      {
        sessionId: "session-1",
        stage: "deep",
        startedAt: new Date("2026-05-01T04:00:00.000Z"),
        endedAt: new Date("2026-05-01T05:00:00.000Z"),
      },
      {
        sessionId: "session-1",
        stage: "rem",
        startedAt: new Date("2026-05-01T05:00:00.000Z"),
        endedAt: new Date("2026-05-01T06:00:00.000Z"),
      },
    ]);
  });

  it("skips sleep stages without stage rows or matching local sessions", async () => {
    const noStageClient = makeClient();
    vi.spyOn(noStageClient, "getSleep").mockResolvedValue({
      id: 456,
      user_id: 123,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      timezone_offset: "Z",
      nap: false,
      stages: [],
    });
    const firstContext = makeContext({
      client: noStageClient,
      cycles: [{ sleep: { id: 456 } }],
    });

    await expect(syncWhoopSleepStages(firstContext)).resolves.toBe(0);

    const db = makeDb([]);
    const stageClient = makeClient();
    vi.spyOn(stageClient, "getSleep").mockResolvedValue({
      id: 789,
      user_id: 123,
      created_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
      timezone_offset: "Z",
      nap: false,
      stages: [{ stage: "light", during: "['2026-05-01T04:00:00Z','2026-05-01T05:00:00Z')" }],
    });
    const secondContext = makeContext({
      db: db.db,
      client: stageClient,
      cycles: [{ sleep: { id: 789 } }],
    });

    await expect(syncWhoopSleepStages(secondContext)).resolves.toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("reconciles provider absence using developer workout ids in the sync window", async () => {
    const db = makeDb();
    const client = makeClient();
    vi.spyOn(client, "listDeveloperWorkoutIdsInWindow").mockResolvedValue(
      new Set(["present-workout", "42"]),
    );
    const context = makeContext({
      db: db.db,
      client,
      options: undefined,
      cycles: [
        {
          workouts: [
            makeWorkoutRecord({ activity_id: "present-workout" }),
            makeWorkoutRecordWithRawActivityId(null),
            makeWorkoutRecordWithRawActivityId(42),
          ],
        },
      ],
    });

    await expect(syncWhoopWorkouts(context)).resolves.toBe(2);

    const absenceWindow = new SyncWindow({
      since: context.since,
      until: context.windowEnd,
    }).withMinimumLookback(30);
    expect(providerActivityAbsenceMocks.reconcileProviderActivityAbsence).toHaveBeenCalledWith(
      db.db,
      {
        providerId: "whoop",
        userId: undefined,
        windowStart: absenceWindow.since,
        windowEnd: absenceWindow.until,
        presentExternalIds: new Set(["present-workout", "42"]),
      },
    );
    const reconcileArgs =
      providerActivityAbsenceMocks.reconcileProviderActivityAbsence.mock.calls[0]?.[1];
    if (!reconcileArgs) throw new Error("expected reconciliation call");
    expect([...reconcileArgs.presentExternalIds].sort()).toEqual(["42", "present-workout"]);
  });

  it("passes sync user id through to workout absence reconciliation", async () => {
    const db = makeDb();
    const client = makeClient();
    vi.spyOn(client, "listDeveloperWorkoutIdsInWindow").mockResolvedValue(
      new Set(["present-workout"]),
    );
    const context = makeContext({
      db: db.db,
      client,
      options: { userId: "user-1" },
      cycles: [{ workouts: [makeWorkoutRecord({ activity_id: "present-workout" })] }],
    });

    await expect(syncWhoopWorkouts(context)).resolves.toBe(1);

    const absenceWindow = new SyncWindow({
      since: context.since,
      until: context.windowEnd,
    }).withMinimumLookback(30);
    expect(providerActivityAbsenceMocks.reconcileProviderActivityAbsence).toHaveBeenCalledWith(
      db.db,
      expect.objectContaining({
        userId: "user-1",
        windowStart: absenceWindow.since,
        windowEnd: absenceWindow.until,
        presentExternalIds: new Set(["present-workout"]),
      }),
    );
  });

  it("skips workout absence reconciliation when developer workout listing fails", async () => {
    const db = makeDb();
    const client = makeClient();
    const developerError = new Error("developer API unavailable");
    vi.spyOn(client, "listDeveloperWorkoutIdsInWindow").mockRejectedValue(developerError);
    const context = makeContext({
      db: db.db,
      client,
      options: { userId: "user-1" },
      cycles: [
        {
          workouts: [
            makeWorkoutRecord({ activity_id: "present-workout" }),
            makeWorkoutRecordWithRawActivityId(null),
            makeWorkoutRecordWithRawActivityId(42),
          ],
        },
      ],
    });

    await expect(syncWhoopWorkouts(context)).resolves.toBe(2);

    expect(context.errors).toEqual([
      {
        message: "developer workouts: developer API unavailable",
        cause: developerError,
      },
    ]);
    expect(providerActivityAbsenceMocks.reconcileProviderActivityAbsence).not.toHaveBeenCalled();
  });
});
