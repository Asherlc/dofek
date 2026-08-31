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
    };

    await expect(new HealthExplorerService(reader).snapshot(input)).resolves.toEqual({
      range: { start_date: "2026-08-01", end_date: "2026-08-03", granularity: "daily" },
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
      coverage: { observed_days: 2, requested_days: 3 },
    });
  });
});
