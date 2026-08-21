import { describe, expect, it, vi } from "vitest";
import type { JoinedDay } from "../insights/data-join.ts";
import { joinByDate } from "../insights/data-join.ts";
import { CorrelationRepository } from "./correlation-repository.ts";

vi.mock("../insights/data-join.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../insights/data-join.ts")>()),
  joinByDate: vi.fn().mockReturnValue([]),
}));

function makeJoinedDay(overrides: Partial<JoinedDay> & { date: string }): JoinedDay {
  return {
    resting_hr: null,
    hrv: null,
    spo2_avg: null,
    skin_temp_c: null,
    sleep_duration_min: null,
    deep_min: null,
    rem_min: null,
    sleep_efficiency: null,
    calories: null,
    protein_g: null,
    carbs_g: null,
    fat_g: null,
    fiber_g: null,
    steps: null,
    exercise_minutes: null,
    cardio_minutes: null,
    strength_minutes: null,
    flexibility_minutes: null,
    weight_kg: null,
    body_fat_pct: null,
    weight_30d_avg: null,
    ...overrides,
  };
}

describe("CorrelationRepository.listMetricOutcomes", () => {
  it("returns only observed canonical metric values with their resolved provider provenance", async () => {
    vi.mocked(joinByDate).mockReturnValueOnce([
      makeJoinedDay({ date: "2026-01-02", hrv: 45 }),
      makeJoinedDay({ date: "2026-01-03", hrv: null }),
    ]);
    const db = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([
          {
            date: "2026-01-02",
            resting_hr: 52,
            hrv: 45,
            spo2_avg: 98,
            steps: 10_000,
            skin_temp_c: 36.5,
            source_providers: ["oura", "garmin", "oura"],
          },
        ])
        .mockResolvedValueOnce([]),
    };
    const sensorStore = {
      query: vi.fn(async (_schema: unknown, query: string) => {
        if (query.includes("analytics.resting_heart_rate_sleep_window")) {
          return [];
        }
        return [];
      }),
    };
    const repository = new CorrelationRepository(db, "user-1", "UTC", sensorStore);

    await expect(repository.listMetricOutcomes("hrv", 30, "2026-01-03")).resolves.toEqual([
      { date: "2026-01-02", value: 45, sourceProviderIds: ["garmin", "oura"] },
    ]);
  });
});
