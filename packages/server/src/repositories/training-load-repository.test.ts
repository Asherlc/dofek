import { describe, expect, it, vi } from "vitest";
import { TrainingLoadRepository } from "./training-load-repository.ts";

describe("TrainingLoadRepository", () => {
  it("returns daily load with 7-day and 28-day window coverage", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        date: "2026-08-05",
        daily_load: 75,
        acute_load_7d: 75,
        chronic_load_28d: 525,
        workload_ratio: null,
        acute_coverage_days: 1,
        chronic_coverage_days: 1,
      },
      {
        date: "2026-09-01",
        daily_load: 75,
        acute_load_7d: 420,
        chronic_load_28d: 350,
        workload_ratio: 1.2,
        acute_coverage_days: 7,
        chronic_coverage_days: 28,
      },
    ]);
    const repository = new TrainingLoadRepository(
      { query },
      "00000000-0000-4000-8000-000000000001",
    );

    await expect(repository.listRange("2026-08-01", "2026-09-01")).resolves.toEqual([
      {
        date: "2026-08-05",
        daily_load: 75,
        acute_load_7d: 75,
        chronic_load_28d: 525,
        workload_ratio: null,
        coverage: { acute_window_days: 1, chronic_window_days: 1 },
      },
      {
        date: "2026-09-01",
        daily_load: 75,
        acute_load_7d: 420,
        chronic_load_28d: 350,
        workload_ratio: 1.2,
        coverage: { acute_window_days: 7, chronic_window_days: 28 },
      },
    ]);
    expect(query.mock.calls[0]?.[1]).toContain("FROM analytics.daily_strain AS strain FINAL");
    expect(query.mock.calls[0]?.[1]).toContain("dateDiff('day', first_observed, strain.date) + 1");
  });
});
