import { describe, expect, it } from "vitest";
import { healthExplorerInputSchema, healthExplorerSnapshotSchema } from "./health-explorer.ts";

describe("healthExplorerInputSchema", () => {
  it("defaults to a bounded daily health-trend request", () => {
    expect(
      healthExplorerInputSchema.parse({
        start_date: "2026-08-01",
        end_date: "2026-08-07",
      }),
    ).toEqual({
      start_date: "2026-08-01",
      end_date: "2026-08-07",
      metrics: ["hrv", "resting_hr"],
      granularity: "daily",
    });
  });

  it("rejects a reversed or overly long date range", () => {
    const reversedRange = healthExplorerInputSchema.safeParse({
      start_date: "2026-08-08",
      end_date: "2026-08-01",
    });
    expect(reversedRange).toMatchObject({
      success: false,
      error: {
        issues: [{ message: "start_date must be on or before end_date", path: ["end_date"] }],
      },
    });

    const overlyLongRange = healthExplorerInputSchema.safeParse({
      start_date: "2025-01-01",
      end_date: "2026-01-03",
    });
    expect(overlyLongRange).toMatchObject({
      success: false,
      error: {
        issues: [{ message: "date range must not exceed 366 days", path: ["end_date"] }],
      },
    });
  });

  it("allows same-day requests and the maximum 366-day span", () => {
    expect(
      healthExplorerInputSchema.parse({
        start_date: "2026-08-01",
        end_date: "2026-08-01",
      }),
    ).toMatchObject({ start_date: "2026-08-01", end_date: "2026-08-01" });
    expect(
      healthExplorerInputSchema.parse({
        start_date: "2025-01-01",
        end_date: "2026-01-02",
      }),
    ).toMatchObject({ start_date: "2025-01-01", end_date: "2026-01-02" });
  });

  it("rejects duplicate metrics", () => {
    const result = healthExplorerInputSchema.safeParse({
      start_date: "2026-08-01",
      end_date: "2026-08-07",
      metrics: ["hrv", "hrv"],
    });

    expect(result).toMatchObject({
      success: false,
      error: { issues: [{ message: "metrics must not contain duplicates", path: ["metrics"] }] },
    });
  });
});

describe("healthExplorerSnapshotSchema", () => {
  it("accepts server-provided summaries and missing observations", () => {
    const snapshot = {
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
    };

    expect(healthExplorerSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });
});
