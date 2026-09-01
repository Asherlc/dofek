import type { HealthExplorerInput } from "@dofek/mcp-contracts/health-explorer";
import { describe, expect, it } from "vitest";
import { HealthExplorerService } from "./health-explorer-service.ts";

describe("HealthExplorerService", () => {
  it("builds chart points, summaries, and coverage on the server", async () => {
    const reader = {
      list: async () => [
        { date: "2026-08-01", metrics: { hrv: { avg: 51 } } },
        { date: "2026-08-02", metrics: {} },
        { date: "2026-08-03", metrics: { hrv: { avg: 56 } } },
      ],
    };
    const input: HealthExplorerInput = {
      start_date: "2026-08-01",
      end_date: "2026-08-03",
      metrics: ["hrv"],
      granularity: "daily",
      timezone: "America/Los_Angeles",
    };

    await expect(new HealthExplorerService(reader).snapshot(input)).resolves.toEqual({
      range: {
        start_date: "2026-08-01",
        end_date: "2026-08-03",
        granularity: "daily",
        timezone: "America/Los_Angeles",
      },
      series: [
        {
          metric: "hrv",
          label: "Heart rate variability",
          unit: "ms",
          points: [
            { key: "2026-08-01", value: 51 },
            { key: "2026-08-02", value: null },
            { key: "2026-08-03", value: 56 },
          ],
        },
      ],
      summary: [{ metric: "hrv", average: 53.5, min: 51, max: 56 }],
      coverage: {
        requested_days: 3,
        by_metric: {
          hrv: {
            observed_days: 2,
            missing_days: ["2026-08-02"],
            missing_days_truncated_count: 0,
          },
        },
      },
    });
  });

  it("preserves weekly periods with no observed metric values", async () => {
    const reader = {
      list: async () => [{ week: "2026-W31", metrics: {} }],
    };
    const input: HealthExplorerInput = {
      start_date: "2026-08-01",
      end_date: "2026-08-07",
      metrics: ["hrv"],
      granularity: "weekly",
      timezone: "America/Los_Angeles",
    };

    await expect(new HealthExplorerService(reader).snapshot(input)).resolves.toEqual({
      range: {
        start_date: "2026-08-01",
        end_date: "2026-08-07",
        granularity: "weekly",
        timezone: "America/Los_Angeles",
      },
      series: [
        {
          metric: "hrv",
          label: "Heart rate variability",
          unit: "ms",
          points: [{ key: "2026-W31", value: null }],
        },
      ],
      summary: [{ metric: "hrv", average: null, min: null, max: null }],
      coverage: {
        requested_days: 7,
        by_metric: {
          hrv: {
            observed_days: 0,
            missing_days: [
              "2026-08-01",
              "2026-08-02",
              "2026-08-03",
              "2026-08-04",
              "2026-08-05",
              "2026-08-06",
              "2026-08-07",
            ],
            missing_days_truncated_count: 0,
          },
        },
      },
    });
  });
});
