import type { HealthExplorerInput } from "@dofek/mcp-contracts/health-explorer";
import { describe, expect, it } from "vitest";
import { buildHealthSeries } from "./health-series-service.ts";

const input: HealthExplorerInput = {
  start_date: "2026-08-21",
  end_date: "2026-08-23",
  metrics: ["hrv", "steps"],
  granularity: "daily",
  timezone: "America/Los_Angeles",
};

describe("buildHealthSeries", () => {
  it("emits null gaps and an explicit no-data series with per-metric coverage", () => {
    const result = buildHealthSeries(
      [
        { date: "2026-08-21", metrics: {} },
        { date: "2026-08-22", metrics: { hrv: { avg: 60 } } },
        { date: "2026-08-23", metrics: {} },
      ],
      input,
    );

    expect(result.series).toEqual([
      {
        metric: "hrv",
        label: "Heart rate variability",
        unit: "ms",
        points: [
          { key: "2026-08-21", value: null, baseline_relative: null },
          { key: "2026-08-22", value: 60, baseline_relative: null },
          { key: "2026-08-23", value: null, baseline_relative: null },
        ],
        note: null,
        summary: { average: 60, min: 60, max: 60 },
        coverage: {
          observed_days: 1,
          missing_days: ["2026-08-21", "2026-08-23"],
          missing_days_truncated_count: 0,
        },
      },
      {
        metric: "steps",
        label: "Steps",
        unit: "steps",
        points: [],
        note: "no_data_in_range",
        summary: { average: null, min: null, max: null },
        coverage: {
          observed_days: 0,
          missing_days: ["2026-08-21", "2026-08-22", "2026-08-23"],
          missing_days_truncated_count: 0,
        },
      },
    ]);
    expect(result.requested_days).toBe(3);
  });
});
