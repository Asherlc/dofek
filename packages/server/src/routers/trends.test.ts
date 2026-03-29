import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
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
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

describe("trendsRouter", () => {
  async function makeCaller(executeResult: unknown[] = []) {
    const execute = vi.fn().mockResolvedValue(executeResult);
    const { trendsRouter } = await import("./trends.ts");
    const callerFactory = createTestCallerFactory(trendsRouter);
    return {
      caller: callerFactory({ db: { execute }, userId: "user-1", timezone: "UTC" }),
      execute,
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

  describe("daily", () => {
    it("returns empty array when no data", async () => {
      const { caller } = await makeCaller([]);
      const result = await caller.daily({});
      expect(result).toEqual([]);
    });

    it("uses default days (365) when not specified", async () => {
      const { caller, execute } = await makeCaller([]);
      await caller.daily({});
      expect(execute).toHaveBeenCalled();
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
  });

  describe("weekly", () => {
    it("returns empty array when no data", async () => {
      const { caller } = await makeCaller([]);
      const result = await caller.weekly({});
      expect(result).toEqual([]);
    });

    it("uses default weeks (52) when not specified", async () => {
      const { caller, execute } = await makeCaller([]);
      await caller.weekly({});
      expect(execute).toHaveBeenCalled();
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
  });
});
