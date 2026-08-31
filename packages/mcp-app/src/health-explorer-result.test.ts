import { describe, expect, it } from "vitest";
import { parseHealthExplorerResult } from "./health-explorer-result.ts";

describe("parseHealthExplorerResult", () => {
  it("returns a valid Explorer snapshot", () => {
    expect(
      parseHealthExplorerResult({
        range: { start_date: "2026-08-01", end_date: "2026-08-01", granularity: "daily" },
        series: [
          {
            metric: "hrv",
            label: "Heart rate variability",
            unit: "ms",
            points: [{ key: "2026-08-01", value: 51 }],
          },
        ],
        summary: [{ metric: "hrv", average: 51, min: 51, max: 51 }],
        coverage: { observed_days: 1, requested_days: 1 },
      }),
    ).toMatchObject({ series: [{ metric: "hrv" }] });
  });

  it("rejects malformed tool content", () => {
    expect(parseHealthExplorerResult({})).toBeNull();
  });
});
