import { beforeEach, describe, expect, it, vi } from "vitest";
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

import { sleepRouter } from "./sleep.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(sleepRouter);

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
