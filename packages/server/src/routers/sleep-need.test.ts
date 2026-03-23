import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    cachedProtectedQuery: () => t.procedure,
    cachedProtectedQueryLight: () => t.procedure,
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

import { sleepNeedRouter } from "./sleep-need.ts";

const createCaller = createTestCallerFactory(sleepNeedRouter);

describe("sleepNeedRouter", () => {
  // ── calculate ──────────────────────────────────────────

  describe("calculate", () => {
    it("returns default baseline (480 min) when no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      expect(result.baselineMinutes).toBe(480);
      expect(result.strainDebtMinutes).toBe(0);
      expect(result.accumulatedDebtMinutes).toBe(0);
      expect(result.totalNeedMinutes).toBe(480);
      expect(result.recentNights).toEqual([]);
    });

    it("computes baseline from good recovery nights when >= 7 good nights", async () => {
      // Create nights where good_recovery is true and duration varies
      const rows = Array.from({ length: 10 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 450 + i * 5, // 450, 455, 460, ... 495
        next_day_hrv: 50,
        median_hrv: 45,
        good_recovery: true,
        yesterday_load: 0,
      }));

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      // Average of 450, 455, 460, 465, 470, 475, 480, 485, 490, 495 = 472.5
      expect(result.baselineMinutes).toBe(473); // rounded
    });

    it("uses default baseline of 480 when fewer than 7 good recovery nights", async () => {
      const rows = Array.from({ length: 5 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 450,
        next_day_hrv: 50,
        median_hrv: 45,
        good_recovery: true,
        yesterday_load: 0,
      }));

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      expect(result.baselineMinutes).toBe(480);
    });

    it("excludes bad recovery nights from baseline calculation", async () => {
      const rows = [
        // 7 good nights at 420 min
        ...Array.from({ length: 7 }, (_, i) => ({
          date: `2026-03-${String(i + 1).padStart(2, "0")}`,
          duration_minutes: 420,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        })),
        // 3 bad recovery nights at 600 min (should be excluded from baseline)
        ...Array.from({ length: 3 }, (_, i) => ({
          date: `2026-03-${String(i + 8).padStart(2, "0")}`,
          duration_minutes: 600,
          next_day_hrv: 30,
          median_hrv: 45,
          good_recovery: false,
          yesterday_load: 0,
        })),
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      // Only good nights (420 min each) count for baseline
      expect(result.baselineMinutes).toBe(420);
    });

    it("computes strain debt from yesterday's load, capped at 60 minutes", async () => {
      const rows = [
        {
          date: "2026-03-01",
          duration_minutes: 480,
          next_day_hrv: 50,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 200, // 200 / 5 = 40 min
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      // Only 1 good night < 7 -> baseline defaults to 480
      // strainDebt = Math.min(60, Math.round(200 / 5)) = Math.min(60, 40) = 40
      expect(result.strainDebtMinutes).toBe(40);
    });

    it("caps strain debt at 60 minutes for very high load", async () => {
      const rows = [
        {
          date: "2026-03-01",
          duration_minutes: 480,
          next_day_hrv: 50,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 500, // 500 / 5 = 100, capped to 60
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      expect(result.strainDebtMinutes).toBe(60);
    });

    it("uses yesterday_load from first row in array", async () => {
      const rows = [
        {
          date: "2026-02-28",
          duration_minutes: 480,
          next_day_hrv: 50,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 150,
        },
        {
          date: "2026-03-01",
          duration_minutes: 480,
          next_day_hrv: 50,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0, // different value in second row
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      // yesterdayLoad = rows[0].yesterday_load = 150
      // strainDebt = min(60, round(150/5)) = min(60, 30) = 30
      expect(result.strainDebtMinutes).toBe(30);
    });

    it("defaults yesterday_load to 0 when no rows", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      expect(result.strainDebtMinutes).toBe(0);
    });

    it("computes accumulated sleep debt over last 14 nights", async () => {
      // 14 nights each at 430 min with baseline 480
      const rows = Array.from({ length: 20 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 430,
        next_day_hrv: 55,
        median_hrv: 45,
        good_recovery: true,
        yesterday_load: 0,
      }));

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      // baseline = avg of 20 good nights at 430 = 430
      // last14: all 430, deficit per night = 430 - 430 = 0
      expect(result.accumulatedDebtMinutes).toBe(0);
    });

    it("accumulated debt only counts positive deficits", async () => {
      // Mixed nights: some above, some below baseline
      const rows = [
        ...Array.from({ length: 7 }, (_, i) => ({
          date: `2026-02-${String(i + 20).padStart(2, "0")}`,
          duration_minutes: 480,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        })),
        // These 7 nights are at 420 (below baseline of 480)
        ...Array.from({ length: 7 }, (_, i) => ({
          date: `2026-03-${String(i + 1).padStart(2, "0")}`,
          duration_minutes: 420,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        })),
        // These 7 nights are at 520 (above baseline of 480)
        ...Array.from({ length: 7 }, (_, i) => ({
          date: `2026-03-${String(i + 8).padStart(2, "0")}`,
          duration_minutes: 520,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        })),
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      // Baseline = avg of 21 good nights = (7*480 + 7*420 + 7*520) / 21 = (3360+2940+3640)/21 = 9940/21 ≈ 473
      // last14: 7 nights at 420, 7 at 520
      // deficit per 420 night = 473 - 420 = 53 -> 7 * 53 = 371
      // deficit per 520 night = 473 - 520 = -47 -> 0 (only positive counts)
      // accumulatedDebt = 371
      expect(result.accumulatedDebtMinutes).toBeGreaterThan(0);
    });

    it("totalNeedMinutes = baseline + strainDebt + debtRecovery", async () => {
      const rows = Array.from({ length: 14 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 400,
        next_day_hrv: 55,
        median_hrv: 45,
        good_recovery: true,
        yesterday_load: 100,
      }));

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      // baseline = avg of 14 good nights at 400 = 400 (>= 7 good nights)
      // strainDebt = min(60, round(100/5)) = 20
      // accumulatedDebt: last14 nights at 400, baseline=400 -> 0 deficit per night
      // debtRecovery = round(0 * 0.25) = 0
      // total = 400 + 20 + 0 = 420
      expect(result.totalNeedMinutes).toBe(
        result.baselineMinutes +
          result.strainDebtMinutes +
          Math.round(result.accumulatedDebtMinutes * 0.25),
      );
    });

    it("recentNights shows last 7 nights with debt tracking", async () => {
      const rows = Array.from({ length: 14 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 450,
        next_day_hrv: 55,
        median_hrv: 45,
        good_recovery: true,
        yesterday_load: 0,
      }));

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      expect(result.recentNights).toHaveLength(7);
      // baseline = 450 (14 good nights at 450)
      // Each night: actual=450, needed=450, debt=max(0, 450-450) = 0
      for (const night of result.recentNights) {
        expect(night.actualMinutes).toBe(450);
        expect(night.neededMinutes).toBe(450);
        expect(night.debtMinutes).toBe(0);
      }
    });

    it("recentNights dates are the last 7 from the dataset", async () => {
      const rows = Array.from({ length: 14 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 450,
        next_day_hrv: 55,
        median_hrv: 45,
        good_recovery: true,
        yesterday_load: 0,
      }));

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      // Last 7 should be dates 08 through 14
      expect(result.recentNights[0]?.date).toBe("2026-03-08");
      expect(result.recentNights[6]?.date).toBe("2026-03-14");
    });

    it("recentNights computes positive debt when actual < baseline", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        date: `2026-03-${String(i + 1).padStart(2, "0")}`,
        duration_minutes: 420,
        next_day_hrv: 55,
        median_hrv: 45,
        good_recovery: true,
        yesterday_load: 0,
      }));

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      // baseline = 420, actual = 420, debt = 0
      // All at 420 so no debt
      for (const night of result.recentNights) {
        expect(night.debtMinutes).toBe(0);
      }
    });

    it("recentNights debt is 0 when actual > baseline", async () => {
      // 8 good nights at 480 and 2 good nights at 520 (all good)
      const rows = [
        ...Array.from({ length: 8 }, (_, i) => ({
          date: `2026-03-${String(i + 1).padStart(2, "0")}`,
          duration_minutes: 480,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        })),
        ...Array.from({ length: 2 }, (_, i) => ({
          date: `2026-03-${String(i + 9).padStart(2, "0")}`,
          duration_minutes: 520,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        })),
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      // baseline = (8*480 + 2*520)/10 = (3840 + 1040)/10 = 488
      // Recent nights at 520 have debtMinutes = max(0, 488-520) = 0
      const nights520 = result.recentNights.filter((n) => n.actualMinutes === 520);
      for (const night of nights520) {
        expect(night.debtMinutes).toBe(0);
      }
    });

    it("excludes zero-duration good nights from baseline", async () => {
      // Some good nights with 0 duration should be excluded
      const rows = [
        ...Array.from({ length: 7 }, (_, i) => ({
          date: `2026-03-${String(i + 1).padStart(2, "0")}`,
          duration_minutes: 480,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        })),
        {
          date: "2026-03-08",
          duration_minutes: 0,
          next_day_hrv: 55,
          median_hrv: 45,
          good_recovery: true,
          yesterday_load: 0,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.calculate();

      // Only 7 good nights with duration > 0 at 480 each
      expect(result.baselineMinutes).toBe(480);
    });
  });

  // ── performance ──────────────────────────────────────────

  describe("performance", () => {
    it("returns null when no sleep data", async () => {
      const executeMock = vi.fn();
      // First call: sleep rows
      executeMock.mockResolvedValueOnce([]);

      const caller = createCaller({
        db: { execute: executeMock },
        userId: "user-1",
      });
      const result = await caller.performance();

      expect(result).toBeNull();
    });

    it("returns null when duration_minutes is null", async () => {
      const executeMock = vi.fn();
      executeMock.mockResolvedValueOnce([{ duration_minutes: null, efficiency_pct: 90 }]);

      const caller = createCaller({
        db: { execute: executeMock },
        userId: "user-1",
      });
      const result = await caller.performance();

      expect(result).toBeNull();
    });

    it("returns sleep performance info when data is available", async () => {
      const executeMock = vi.fn();
      // First call: sleep rows
      executeMock.mockResolvedValueOnce([{ duration_minutes: 450, efficiency_pct: 92 }]);
      // Second call: baseline rows
      executeMock.mockResolvedValueOnce([{ avg_duration: 480 }]);

      const caller = createCaller({
        db: { execute: executeMock },
        userId: "user-1",
      });
      const result = await caller.performance();

      expect(result).not.toBeNull();
      expect(result?.actualMinutes).toBe(450);
      expect(result?.neededMinutes).toBe(480);
      expect(result?.efficiency).toBe(92);
      expect(result?.score).toBeGreaterThanOrEqual(0);
      expect(result?.score).toBeLessThanOrEqual(100);
      expect(["Peak", "Perform", "Get By", "Low"]).toContain(result?.tier);
      expect(result?.recommendedBedtime).toMatch(/^\d{2}:\d{2}$/);
    });

    it("uses default efficiency of 85 when null", async () => {
      const executeMock = vi.fn();
      executeMock.mockResolvedValueOnce([{ duration_minutes: 480, efficiency_pct: null }]);
      executeMock.mockResolvedValueOnce([{ avg_duration: 480 }]);

      const caller = createCaller({
        db: { execute: executeMock },
        userId: "user-1",
      });
      const result = await caller.performance();

      expect(result).not.toBeNull();
      expect(result?.efficiency).toBe(85);
    });

    it("uses default baseline of 480 when avg_duration is null", async () => {
      const executeMock = vi.fn();
      executeMock.mockResolvedValueOnce([{ duration_minutes: 450, efficiency_pct: 90 }]);
      executeMock.mockResolvedValueOnce([{ avg_duration: null }]);

      const caller = createCaller({
        db: { execute: executeMock },
        userId: "user-1",
      });
      const result = await caller.performance();

      expect(result).not.toBeNull();
      expect(result?.neededMinutes).toBe(480);
    });

    it("uses default baseline of 480 when no baseline rows", async () => {
      const executeMock = vi.fn();
      executeMock.mockResolvedValueOnce([{ duration_minutes: 450, efficiency_pct: 90 }]);
      executeMock.mockResolvedValueOnce([]);

      const caller = createCaller({
        db: { execute: executeMock },
        userId: "user-1",
      });
      const result = await caller.performance();

      expect(result).not.toBeNull();
      expect(result?.neededMinutes).toBe(480);
    });

    it("computes recommended bedtime in HH:MM format", async () => {
      const executeMock = vi.fn();
      executeMock.mockResolvedValueOnce([{ duration_minutes: 480, efficiency_pct: 95 }]);
      executeMock.mockResolvedValueOnce([{ avg_duration: 480 }]);

      const caller = createCaller({
        db: { execute: executeMock },
        userId: "user-1",
      });
      const result = await caller.performance();

      expect(result?.recommendedBedtime).toMatch(/^\d{2}:\d{2}$/);
      // For 480 min need + 15 min fall-asleep, from 07:00 wake time:
      // 420 min (7h) - 480 - 15 = -75 min from midnight = 22:45
      expect(result?.recommendedBedtime).toBe("22:45");
    });

    it("rounds neededMinutes to integer", async () => {
      const executeMock = vi.fn();
      executeMock.mockResolvedValueOnce([{ duration_minutes: 450, efficiency_pct: 90 }]);
      executeMock.mockResolvedValueOnce([{ avg_duration: 467.8 }]);

      const caller = createCaller({
        db: { execute: executeMock },
        userId: "user-1",
      });
      const result = await caller.performance();

      expect(result?.neededMinutes).toBe(468);
      expect(Number.isInteger(result?.neededMinutes)).toBe(true);
    });
  });
});
