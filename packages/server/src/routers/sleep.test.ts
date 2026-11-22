import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseRegisteredQueryCacheKey } from "../../../../scripts/warm-query-cache.ts";
import type { AccessWindow } from "../billing/entitlement.ts";
import { requestCacheKey } from "../trpc.ts";

const cache = vi.hoisted(() => new Map<string, unknown>());
vi.mock("dofek/lib/cache", () => ({
  queryCache: {
    get: async (key: string) => cache.get(key),
    set: async (key: string, value: unknown) => {
      cache.set(key, value);
    },
    invalidate: async (key: string) => {
      cache.delete(key);
    },
  },
}));
beforeEach(() => cache.clear());

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

import { appRouter } from "../router.ts";
import { sleepRouter } from "./sleep.ts";
import { createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(sleepRouter);
const createAppCaller = createTestCallerFactory(appRouter);

const analysisInput = { days: 1, endDate: "2026-03-10" };

function episodeRecord(id: string, provider: string, startedAt: string, endedAt: string) {
  return {
    selected_session_id: id,
    source_session_ids: [id],
    source_providers: [provider],
    provider_id: provider,
    source_name: null,
    started_at: startedAt,
    ended_at: endedAt,
    timezone: null,
    start_utc_offset_minutes: null,
    end_utc_offset_minutes: null,
    local_time_source: "unknown",
    is_nap: false,
    sleep_kind_recorded: true,
    duration_minutes: 440,
    efficiency_pct: null,
    deep_minutes: null,
    rem_minutes: null,
    light_minutes: null,
    awake_minutes: null,
    staging_available: false,
  };
}

const preceding = episodeRecord(
  "prior",
  "apple_health",
  "2026-03-08T23:00:00Z",
  "2026-03-09T07:00:00Z",
);
const selected = episodeRecord("target", "polar", "2026-03-09T23:00:00Z", "2026-03-10T07:00:00Z");
const referenceNight = episodeRecord(
  "reference",
  "polar",
  "2026-03-11T23:00:00Z",
  "2026-03-12T07:00:00Z",
);
const fitMember = {
  id: "fit-member",
  started_at: "2026-03-09T20:30:00Z",
  ended_at: "2026-03-09T21:00:00Z",
};
const workoutRecord = {
  sleep_id: "target",
  id: "workout",
  canonical_type: "running",
  provider_type: "run",
  started_at: fitMember.started_at,
  ended_at: fitMember.ended_at,
  source_providers: ["fit-file"],
  matches_filter: true,
  fit_members: [fitMember],
};
const coverageRecord = {
  user_id: "user-1",
  activity_id: workoutRecord.id,
  member_activity_id: fitMember.id,
  started_at: fitMember.started_at,
  ended_at: fitMember.ended_at,
  covered_seconds: 1800,
  bpm_seconds: [[130, 1800]],
  status: "complete",
  is_current: true,
};

function createLateWorkoutsCaller({
  accessWindow,
  userId = "user-1",
  timezone = "UTC",
  episodes = [preceding, selected, referenceNight],
  workoutRows = [workoutRecord],
  coverageRows = [coverageRecord],
  profile = { max_hr: 200, birth_date: null },
}: {
  accessWindow?: AccessWindow;
  userId?: string | null;
  timezone?: string;
  episodes?: unknown[];
  workoutRows?: unknown[];
  coverageRows?: unknown[];
  profile?: { max_hr: number | null; birth_date: string | null };
} = {}) {
  const sensorStore = makeMockSensorStore([episodes, coverageRows]);
  const execute = vi.fn().mockResolvedValueOnce(workoutRows).mockResolvedValueOnce([profile]);
  const caller = createAppCaller({ db: { execute }, userId, timezone, sensorStore, accessWindow });
  return { caller, execute, query: vi.mocked(sensorStore.query) };
}

describe("sleep.lateWorkouts", () => {
  it("returns a matched night and scores complete FIT heart-rate coverage through the app router", async () => {
    const { caller, query } = createLateWorkoutsCaller();
    const result = await caller.sleep.lateWorkouts(analysisInput);

    expect(result).toMatchObject({
      range: { startDate: "2026-03-10", endDate: "2026-03-10", timezone: "UTC" },
      matchedNightCount: 1,
      measuredLoadNightCount: 1,
      axis: { lowerMinutes: -600, upperMinutes: 120, habitualPosition: 5 / 6 },
      nights: [
        {
          date: "2026-03-10",
          episodeId: "target",
          status: "matched",
          habitualOnset: { referenceNights: [{ episodeId: "target" }, { episodeId: "reference" }] },
          actualOnset: "2026-03-09T23:00:00Z",
          workoutFinish: "2026-03-09T21:00:00.000Z",
          finishOffsetMinutes: -120,
          actualOnsetOffsetMinutes: 0,
          minutesFromFinishToSleep: 120,
          plot: { workoutFinish: 2 / 3, actualOnset: 5 / 6 },
          load: { score: 60, category: "light", coveredSeconds: 1800 },
        },
      ],
    });
    expect(query.mock.calls[0]?.[2]).toMatchObject({ userId: "user-1", endDate: "2026-03-31" });
    expect(query.mock.calls[1]?.[2]).toMatchObject({ userId: "user-1", activityIds: ["workout"] });
  });

  it.each([
    { is_current: false },
    { member_activity_id: "superseded" },
    { ended_at: "2026-03-09T20:59:00Z" },
    { status: "incomplete", covered_seconds: 1799 },
    { user_id: "second-account" },
  ])("preserves timing when FIT verification rejects %j", async (overrides) => {
    const { caller } = createLateWorkoutsCaller({
      coverageRows: [{ ...coverageRecord, ...overrides }],
    });
    await expect(caller.sleep.lateWorkouts(analysisInput)).resolves.toMatchObject({
      matchedNightCount: 1,
      measuredLoadNightCount: 0,
      nights: [
        { status: "matched", load: { score: null, category: null, reason: expect.any(String) } },
      ],
    });
  });

  it("uses the age estimate when the profile has a birth date and no personal maximum", async () => {
    const { caller } = createLateWorkoutsCaller({
      profile: { max_hr: null, birth_date: "1991-03-09" },
    });
    const result = await caller.sleep.lateWorkouts(analysisInput);
    expect(result.nights[0]?.load).toMatchObject({
      score: 90,
      category: "light",
      maximums: [{ basis: "age_estimate", age: 35, bpm: 183.425 }],
    });
  });

  it("retains two independently matched episodes but excludes their shared wake date from both counts", async () => {
    const { caller, query } = createLateWorkoutsCaller({
      episodes: [
        preceding,
        episodeRecord("target", "polar", "2026-03-09T17:30:00Z", "2026-03-10T00:05:00Z"),
        episodeRecord("second", "polar", "2026-03-10T00:30:00Z", "2026-03-10T08:00:00Z"),
        referenceNight,
      ],
      workoutRows: [
        {
          ...workoutRecord,
          started_at: "2026-03-09T16:30:00Z",
          ended_at: "2026-03-09T17:00:00Z",
          fit_members: [],
        },
        {
          ...workoutRecord,
          id: "second-workout",
          sleep_id: "second",
          started_at: "2026-03-10T00:10:00Z",
          ended_at: "2026-03-10T00:25:00Z",
          fit_members: [],
        },
      ],
    });
    await expect(caller.sleep.lateWorkouts(analysisInput)).resolves.toMatchObject({
      matchedNightCount: 0,
      measuredLoadNightCount: 0,
      nights: [
        {
          episodeId: "target",
          status: "ambiguous_sleep_date",
          workoutFinish: "2026-03-09T17:00:00.000Z",
        },
        {
          episodeId: "second",
          status: "ambiguous_sleep_date",
          workoutFinish: "2026-03-10T00:25:00.000Z",
        },
      ],
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it("isolates cache reads after access changes for the same account and chart selection", async () => {
    const paid = createLateWorkoutsCaller();
    const limited = createLateWorkoutsCaller({
      accessWindow: {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-03-12",
        endDateExclusive: "2026-03-19",
      },
    });
    expect((await paid.caller.sleep.lateWorkouts(analysisInput)).nights).toHaveLength(1);
    await expect(limited.caller.sleep.lateWorkouts(analysisInput)).resolves.toMatchObject({
      range: { startDate: null, endDate: null },
      nights: [],
    });
    expect(limited.query).not.toHaveBeenCalled();
    expect(limited.execute).not.toHaveBeenCalled();
    const registered = [...cache.keys()].map(parseRegisteredQueryCacheKey);
    expect(registered).toHaveLength(2);
    for (const key of registered) {
      expect(key).toMatchObject({
        userId: "user-1",
        path: "sleep.lateWorkouts",
        timezone: "UTC",
        input: analysisInput,
      });
    }
  });

  it("omits previous wakes and reference nights outside a limited access window", async () => {
    const { caller, query, execute } = createLateWorkoutsCaller({
      accessWindow: {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-03-10",
        endDateExclusive: "2026-03-11",
      },
    });
    await expect(caller.sleep.lateWorkouts(analysisInput)).resolves.toMatchObject({
      matchedNightCount: 0,
      nights: [
        {
          status: "previous_wake_unavailable",
          previousWake: null,
          workouts: [],
          habitualOnset: { referenceNights: [{ episodeId: "target" }] },
        },
      ],
    });
    expect(query.mock.calls[0]?.[2]).toMatchObject({
      startDate: "2026-03-10",
      endDate: "2026-03-10",
      accessStartDate: "2026-03-10",
      accessEndDate: "2026-03-10",
    });
    expect(query).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("clips All to 366 days and requests month boundaries for the requested access", async () => {
    const { caller, query } = createLateWorkoutsCaller({ userId: "second-account", episodes: [] });
    await expect(
      caller.sleep.lateWorkouts({ days: null, endDate: "2026-03-10" }),
    ).resolves.toMatchObject({
      range: { startDate: "2025-03-10", endDate: "2026-03-10" },
      nights: [],
    });
    expect(query.mock.calls[0]?.[2]).toMatchObject({
      userId: "second-account",
      startDate: "2025-02-26",
      endDate: "2026-03-31",
    });
  });

  it("keeps wake context bounded when an imported sleep episode spans multiple years", async () => {
    const { caller, query, execute } = createLateWorkoutsCaller({
      episodes: [
        episodeRecord("malformed", "polar", "2020-01-01T23:00:00Z", "2026-03-10T07:00:00Z"),
      ],
      coverageRows: [],
    });
    await expect(caller.sleep.lateWorkouts(analysisInput)).resolves.toMatchObject({
      matchedNightCount: 0,
      nights: [{ episodeId: "malformed", status: "previous_wake_unavailable", previousWake: null }],
    });
    expect(query.mock.calls[0]?.[2]).toMatchObject({
      startDate: "2026-02-26",
      endDate: "2026-03-31",
    });
    expect(query).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects anonymous callers before reading the databases", async () => {
    const { caller, query } = createLateWorkoutsCaller({ userId: null });
    await expect(caller.sleep.lateWorkouts(analysisInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("sleepRouter access window", () => {
  it("list passes accessWindow to repository (limited window returns empty)", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: {
        query: vi.fn().mockResolvedValue([]),
        getActivitySummaries: vi.fn().mockResolvedValue([]),
        getStream: vi.fn().mockResolvedValue([]),
        getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
        getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
        getPowerCurveSamples: vi.fn().mockResolvedValue([]),
        getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
        getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
        getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
        getPaceCurveRows: vi.fn().mockResolvedValue([]),
      },
      accessWindow: {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-04-10",
        endDateExclusive: "2026-04-17",
      },
    });
    const result = await caller.list({ days: 30, endDate: "2026-04-26" });
    expect(result).toEqual([]);
  });

  it("list uses a lower date bound for finite selected ranges", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: {
        query,
        getActivitySummaries: vi.fn().mockResolvedValue([]),
        getStream: vi.fn().mockResolvedValue([]),
        getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
        getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
        getPowerCurveSamples: vi.fn().mockResolvedValue([]),
        getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
        getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
        getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
        getPaceCurveRows: vi.fn().mockResolvedValue([]),
      },
    });

    await caller.list({ days: 30, endDate: "2026-04-26" });

    const queryText = query.mock.calls[0]?.[1];
    const queryParams = query.mock.calls[0]?.[2];
    expect(queryText).toContain("subtractDays(toDate({endDate:String}), {days:UInt32})");
    expect(queryParams).toMatchObject({ endDate: "2026-04-26", days: 30 });
  });

  it("list omits the lower date bound when days is null", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: {
        query,
        getActivitySummaries: vi.fn().mockResolvedValue([]),
        getStream: vi.fn().mockResolvedValue([]),
        getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
        getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
        getPowerCurveSamples: vi.fn().mockResolvedValue([]),
        getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
        getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
        getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
        getPaceCurveRows: vi.fn().mockResolvedValue([]),
      },
    });

    await caller.list({ days: null, endDate: "2026-04-26" });

    const queryText = query.mock.calls[0]?.[1];
    const queryParams = query.mock.calls[0]?.[2];
    expect(queryText).toContain("WHERE sleep.user_id = {userId:UUID}");
    expect(queryText).toContain("<= toDate({endDate:String})");
    expect(queryText).not.toContain("subtractDays");
    expect(queryParams).toMatchObject({ userId: "user-1", endDate: "2026-04-26" });
    expect(queryParams).not.toHaveProperty("days");
  });
});

describe("sleepRouter stagesByDate", () => {
  it("supplies duration seconds from legacy server cache entries", async () => {
    const interval = {
      stage: "awake",
      started_at: "2026-11-15T23:00:15Z",
      ended_at: "2026-11-15T23:01:30Z",
    };
    const caller = createSleepCaller(vi.fn());
    const datedInput = { date: "2026-04-12" };
    cache.set(requestCacheKey("user-1", "stagesByDate", datedInput, "UTC"), {
      date: datedInput.date,
      stages: [interval],
    });
    expect(await caller.stagesByDate(datedInput)).toEqual({
      date: datedInput.date,
      stages: [{ ...interval, duration_seconds: 75 }],
    });
    cache.set(requestCacheKey("user-1", "latestStages", undefined, "UTC"), [interval]);
    expect(await caller.latestStages()).toEqual([{ ...interval, duration_seconds: 75 }]);
    const sessionInput = { sessionId: "00000000-0000-0000-0000-000000000001" };
    cache.set(requestCacheKey("user-1", "stages", sessionInput, "UTC"), [interval]);
    expect(await caller.stages(sessionInput)).toEqual([{ ...interval, duration_seconds: 75 }]);
  });

  function createSleepCaller(query: ReturnType<typeof vi.fn>) {
    return createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: {
        query,
        getActivitySummaries: vi.fn().mockResolvedValue([]),
        getStream: vi.fn().mockResolvedValue([]),
        getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
        getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
        getPowerCurveSamples: vi.fn().mockResolvedValue([]),
        getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
        getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
        getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
        getPaceCurveRows: vi.fn().mockResolvedValue([]),
      },
      accessWindow: {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-04-10",
        endDateExclusive: "2026-04-17",
      },
    });
  }

  it("returns exactly the requested date, including a missing date", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const caller = createSleepCaller(query);

    await expect(caller.stagesByDate({ date: "2026-04-12" })).resolves.toEqual({
      date: "2026-04-12",
      stages: [],
    });
    expect(query.mock.calls[0]?.[2]).toMatchObject({ days: 0, endDate: "2026-04-12" });
  });

  it("does not expose dates outside the caller's sleep access window", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const caller = createSleepCaller(query);

    await expect(caller.stagesByDate({ date: "2026-04-18" })).resolves.toEqual({
      date: "2026-04-18",
      stages: [],
    });
    expect(query.mock.calls[0]?.[1]).toContain("sleep.date >= toDate({accessStartDate:String})");
    expect(query.mock.calls[0]?.[2]).toMatchObject({ days: 0, endDate: "2026-04-18" });
  });

  it("defaults omitted input to the latest recorded sleep night", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        date: "2026-04-16",
        started_at: "2026-04-16T23:00:00Z",
        ended_at: "2026-04-17T07:00:00Z",
        staging_available: true,
      },
    ]);
    const caller = createSleepCaller(query);

    await expect(caller.stagesByDate()).resolves.toEqual({ date: "2026-04-16", stages: [] });
    expect(query.mock.calls[0]?.[1]).toContain("ORDER BY sleep.date DESC");
    expect(query.mock.calls[0]?.[2]).toMatchObject({ userId: "user-1" });
    expect(query.mock.calls[0]?.[2]).not.toHaveProperty("endDate");
  });

  it("validates calendar dates and keeps empty object input valid", async () => {
    const caller = createSleepCaller(vi.fn().mockResolvedValue([]));

    await expect(caller.stagesByDate({})).resolves.toEqual({ date: null, stages: [] });
    await expect(caller.stagesByDate({ date: "2026-02-30" })).rejects.toThrow();
  });
});
