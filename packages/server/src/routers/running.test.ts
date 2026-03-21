import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    cachedProtectedQueryLight: () => trpc.procedure,
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

import { runningRouter } from "./running.ts";

const createCaller = createTestCallerFactory(runningRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
  });
}

describe("runningRouter", () => {
  describe("dynamics", () => {
    it("returns empty when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.dynamics({ days: 90 });
      expect(result).toEqual([]);
    });

    it("maps running dynamics fields correctly", async () => {
      const rows = [
        {
          date: "2026-01-15",
          name: "Morning Run",
          avg_cadence: 172,
          avg_stride_length: 1.15,
          avg_stance_time: 245,
          avg_vertical_osc: 8.2,
          avg_speed: 3.5,
          total_distance: 8500,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.dynamics({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        date: "2026-01-15",
        activityName: "Morning Run",
        cadence: 172,
        strideLengthMeters: 1.15,
        stanceTimeMs: 245,
        verticalOscillationMm: 8.2,
        paceSecondsPerKm: 286, // 1000 / 3.5 ≈ 285.7 → rounds to 286
        distanceKm: 8.5,
      });
    });

    it("returns multiple activities sorted by date", async () => {
      const rows = [
        {
          date: "2026-01-10",
          name: "Easy Run",
          avg_cadence: 168,
          avg_stride_length: 1.1,
          avg_stance_time: 260,
          avg_vertical_osc: 9.0,
          avg_speed: 3.0,
          total_distance: 5000,
        },
        {
          date: "2026-01-12",
          name: "Tempo Run",
          avg_cadence: 178,
          avg_stride_length: 1.25,
          avg_stance_time: 230,
          avg_vertical_osc: 7.5,
          avg_speed: 4.0,
          total_distance: 10000,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.dynamics({ days: 90 });

      expect(result).toHaveLength(2);
      expect(result[0]?.activityName).toBe("Easy Run");
      expect(result[1]?.activityName).toBe("Tempo Run");
    });

    it("handles null stride length gracefully", async () => {
      const rows = [
        {
          date: "2026-01-15",
          name: "Treadmill",
          avg_cadence: 170,
          avg_stride_length: null,
          avg_stance_time: null,
          avg_vertical_osc: null,
          avg_speed: 3.2,
          total_distance: 6000,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.dynamics({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]?.strideLengthMeters).toBeNull();
      expect(result[0]?.stanceTimeMs).toBeNull();
      expect(result[0]?.verticalOscillationMm).toBeNull();
    });
  });

  describe("paceTrend", () => {
    it("returns empty when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.paceTrend({ days: 90 });
      expect(result).toEqual([]);
    });

    it("returns pace trend data", async () => {
      const rows = [
        {
          date: "2026-01-15",
          name: "Morning Run",
          avg_speed: 3.5,
          total_distance: 8500,
          duration_seconds: 2400,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.paceTrend({ days: 90 });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        date: "2026-01-15",
        activityName: "Morning Run",
        paceSecondsPerKm: 286,
        distanceKm: 8.5,
        durationMinutes: 40,
      });
    });

    it("returns multiple runs", async () => {
      const rows = [
        {
          date: "2026-01-10",
          name: "Easy",
          avg_speed: 3.0,
          total_distance: 5000,
          duration_seconds: 1667,
        },
        {
          date: "2026-01-12",
          name: "Tempo",
          avg_speed: 4.0,
          total_distance: 10000,
          duration_seconds: 2500,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.paceTrend({ days: 90 });

      expect(result).toHaveLength(2);
      // Faster run should have lower pace (fewer seconds per km)
      expect(result[1]?.paceSecondsPerKm).toBeLessThan(result[0]?.paceSecondsPerKm ?? Infinity);
    });
  });
});
