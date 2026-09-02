import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const { mockCachedProtectedQuery } = vi.hoisted(() => ({
  mockCachedProtectedQuery: vi.fn(),
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; sensorStore?: unknown; userId: string | null; timezone: string }>()
    .create();
  mockCachedProtectedQuery.mockImplementation(() => trpc.procedure);
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: mockCachedProtectedQuery,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

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

describe("trendsRouter", () => {
  async function makeCaller(executeResult: unknown[] = [], includeSensorStore = true) {
    const execute = vi.fn().mockResolvedValue(executeResult);
    const sensorStore = {
      query: vi
        .fn()
        .mockImplementation(async (schema: { parse: (row: unknown) => unknown }) =>
          executeResult.map((row) => schema.parse(row)),
        ),
    };
    const { trendsRouter } = await import("./trends.ts");
    const callerFactory = createTestCallerFactory(trendsRouter);
    return {
      caller: callerFactory({
        db: { execute },
        sensorStore: includeSensorStore ? sensorStore : undefined,
        userId: "user-1",
        timezone: "UTC",
      }),
      execute,
      sensorStore,
    };
  }

  const sampleRow = {
    period: "2026-03-15",
    avg_hr: "142.5",
    max_hr: "185",
    avg_power: "210.3",
    max_power: "380",
    avg_cadence: "88.1",
    avg_speed: "28.57",
    total_samples: "3600",
    hr_samples: "3500",
    power_samples: "3400",
    activity_count: "2",
  };

  it("uses long caches for trend read queries", async () => {
    await import("./trends.ts");

    expect(mockCachedProtectedQuery.mock.calls.map((call) => call[0])).toEqual([
      { maxAge: 3_600_000 },
      { maxAge: 3_600_000 },
    ]);
  });

  describe("daily", () => {
    it("returns empty array when no data", async () => {
      const { caller } = await makeCaller([]);
      const result = await caller.daily({});
      expect(result).toEqual([]);
    });

    it("uses default days (365) when not specified", async () => {
      const { caller, execute, sensorStore } = await makeCaller([]);
      await caller.daily({});
      expect(execute).not.toHaveBeenCalled();
      expect(sensorStore.query).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("analytics.activity_trend_daily"),
        { userId: "user-1", days: 365 },
      );
    });

    it("maps period to date field", async () => {
      const { caller } = await makeCaller([sampleRow]);
      const result = await caller.daily({});
      expect(result).toHaveLength(1);
      expect(result[0]?.date).toBe("2026-03-15");
    });

    it("includes toDetail() fields in response", async () => {
      const { caller } = await makeCaller([sampleRow]);
      const result = await caller.daily({ days: 30 });
      expect(result[0]?.avgHr).toBe(142.5);
      expect(result[0]?.avgSpeed).toBe(28.57);
      expect(result[0]?.activityCount).toBe(2);
    });

    it("rejects unsafe day ranges before querying ClickHouse", async () => {
      const { caller, sensorStore } = await makeCaller([]);
      await expect(caller.daily({ days: -1 })).rejects.toThrow();
      expect(sensorStore.query).not.toHaveBeenCalled();
    });

    it("fails clearly when the ClickHouse sensor store is missing", async () => {
      const { caller, sensorStore } = await makeCaller([], false);
      await expect(caller.daily({})).rejects.toThrow(
        "trends.daily requires the ClickHouse activity analytics store",
      );
      expect(sensorStore.query).not.toHaveBeenCalled();
    });
  });

  describe("weekly", () => {
    it("returns empty array when no data", async () => {
      const { caller } = await makeCaller([]);
      const result = await caller.weekly({});
      expect(result).toEqual([]);
    });

    it("uses default weeks (52) when not specified", async () => {
      const { caller, execute, sensorStore } = await makeCaller([]);
      await caller.weekly({});
      expect(execute).not.toHaveBeenCalled();
      expect(sensorStore.query).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("analytics.activity_trend_daily"),
        { userId: "user-1", days: 364 },
      );
    });

    it("maps period to week field", async () => {
      const { caller } = await makeCaller([sampleRow]);
      const result = await caller.weekly({});
      expect(result).toHaveLength(1);
      expect(result[0]?.week).toBe("2026-03-15");
    });

    it("includes toDetail() fields in response", async () => {
      const { caller } = await makeCaller([sampleRow]);
      const result = await caller.weekly({ weeks: 12 });
      expect(result[0]?.avgHr).toBe(142.5);
      expect(result[0]?.avgPower).toBe(210.3);
      expect(result[0]?.totalSamples).toBe(3600);
    });

    it("rejects unsafe week ranges before querying ClickHouse", async () => {
      const { caller, sensorStore } = await makeCaller([]);
      await expect(caller.weekly({ weeks: 1.5 })).rejects.toThrow();
      expect(sensorStore.query).not.toHaveBeenCalled();
    });

    it("fails clearly when the ClickHouse sensor store is missing", async () => {
      const { caller, sensorStore } = await makeCaller([], false);
      await expect(caller.weekly({})).rejects.toThrow(
        "trends.weekly requires the ClickHouse activity analytics store",
      );
      expect(sensorStore.query).not.toHaveBeenCalled();
    });
  });
});
