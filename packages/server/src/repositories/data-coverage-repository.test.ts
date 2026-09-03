import { describe, expect, it, vi } from "vitest";
import { DataCoverageRepository } from "./data-coverage-repository.ts";

describe("DataCoverageRepository", () => {
  it("returns every health metric with source-aware observed-date coverage", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        metric: "hrv",
        first_observed: "2026-03-09",
        last_observed: "2026-09-01",
        total_days_observed: 170,
        source_providers: ["apple_health"],
      },
      {
        metric: "steps",
        first_observed: null,
        last_observed: null,
        total_days_observed: 0,
        source_providers: [],
      },
    ]);
    const repository = new DataCoverageRepository(
      { query },
      "00000000-0000-4000-8000-000000000001",
      "America/Los_Angeles",
    );

    const result = await repository.list();

    expect(result).toContainEqual({
      metric: "hrv",
      first_observed: "2026-03-09",
      last_observed: "2026-09-01",
      total_days_observed: 170,
      source_providers: ["apple_health"],
    });
    expect(result).toContainEqual({
      metric: "steps",
      first_observed: null,
      last_observed: null,
      total_days_observed: 0,
      source_providers: [],
    });
    expect(query.mock.calls[0]?.[1]).toContain("analytics.v_daily_metrics");
    expect(query.mock.calls[0]?.[1]).toContain("analytics.daily_sleep");
    expect(query.mock.calls[0]?.[1]).toContain("analytics.resting_heart_rate_sleep_window");
    expect(query.mock.calls[0]?.[2]).toEqual({
      timezone: "America/Los_Angeles",
      userId: "00000000-0000-4000-8000-000000000001",
    });
  });
});
