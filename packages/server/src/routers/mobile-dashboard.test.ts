import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone?: string;
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

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn().mockResolvedValue(null),
}));

vi.mock("../repositories/training-repository.ts", () => ({
  computeComponentScores: vi.fn(() => ({
    hrvScore: 62,
    restingHrScore: 62,
    sleepScore: 62,
    respiratoryRateScore: 62,
  })),
  computeReadinessScore: vi.fn(() => 62),
  TrainingRepository: class {
    getNextWorkoutData() {
      return Promise.resolve(null);
    }

    getRecommendation() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("../repositories/anomaly-detection-repository.ts", () => ({
  AnomalyDetectionRepository: class {
    check() {
      return Promise.resolve(null);
    }
  },
}));

import { mobileDashboardRouter } from "./mobile-dashboard.ts";

const createCaller = createTestCallerFactory(mobileDashboardRouter);

describe("mobileDashboard.dashboard", () => {
  it("computes daily strain from rolling acute load when today is a rest day", async () => {
    const execute = vi.fn();
    execute.mockResolvedValueOnce([
      {
        date: "2026-03-28",
        hrv: null,
        resting_hr: null,
        respiratory_rate: null,
        efficiency_pct: null,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        rhr_mean_30d: null,
        rhr_sd_30d: null,
        rr_mean_30d: null,
        rr_sd_30d: null,
        daily_load: 0,
      },
      {
        date: "2026-03-27",
        hrv: null,
        resting_hr: null,
        respiratory_rate: null,
        efficiency_pct: null,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        rhr_mean_30d: null,
        rhr_sd_30d: null,
        rr_mean_30d: null,
        rr_sd_30d: null,
        daily_load: 350,
      },
    ]);
    execute.mockResolvedValueOnce([]);
    execute.mockResolvedValueOnce([]);

    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
    });
    const result = await caller.dashboard({ endDate: "2026-03-28" });

    expect(result.strain.dailyStrain).toBeGreaterThan(0);
    expect(result.strain.acuteLoad).toBe(350);
  });
});
