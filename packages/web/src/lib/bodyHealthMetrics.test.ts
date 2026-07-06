import { describe, expect, it } from "vitest";
import { UnitConverter } from "@dofek/format/units";
import { buildBodyHealthMetrics } from "./bodyHealthMetrics.ts";

describe("buildBodyHealthMetrics", () => {
  it("includes body weight, body fat %, and resting heart rate", () => {
    const metrics = buildBodyHealthMetrics({
      trendData: {
        latest_resting_hr: 55,
        avg_resting_hr: 56.2,
        stddev_resting_hr: 3.1,
      },
      weightData: [
        { date: "2026-06-01", smoothedWeight: 81.2 },
        { date: "2026-06-15", smoothedWeight: 80.8 },
        { date: "2026-06-30", smoothedWeight: 80.1 },
      ],
      recompData: [
        { date: "2026-06-01", bodyFatPct: 19.5 },
        { date: "2026-06-15", bodyFatPct: 19.1 },
        { date: "2026-06-30", bodyFatPct: 18.8 },
      ],
      days: 30,
      endDate: "2026-06-30",
      units: new UnitConverter("metric"),
    });

    expect(metrics.map((metric) => metric.label)).toEqual([
      "Body Weight",
      "Body Fat %",
      "Resting Heart Rate",
    ]);
    expect(metrics[0]).toMatchObject({
      value: 80.1,
      avg: 80.7,
      lowerBetter: true,
    });
    expect(metrics[1]).toMatchObject({
      value: 18.8,
      avg: expect.closeTo(19.133, 2),
      unit: "%",
      lowerBetter: true,
    });
    expect(metrics[2]).toMatchObject({
      value: 55,
      avg: 56.2,
      stddev: 3.1,
      unit: "bpm",
      lowerBetter: true,
    });
  });

  it("limits averages to the selected date window", () => {
    const metrics = buildBodyHealthMetrics({
      trendData: {
        latest_resting_hr: 52,
        avg_resting_hr: 54,
        stddev_resting_hr: 2,
      },
      weightData: [
        { date: "2026-05-01", smoothedWeight: 82 },
        { date: "2026-06-20", smoothedWeight: 80 },
        { date: "2026-06-29", smoothedWeight: 79.5 },
      ],
      recompData: [
        { date: "2026-05-01", bodyFatPct: 20 },
        { date: "2026-06-20", bodyFatPct: 18.5 },
        { date: "2026-06-29", bodyFatPct: 18.2 },
      ],
      days: 30,
      endDate: "2026-06-30",
      units: new UnitConverter("metric"),
    });

    expect(metrics[0]?.avg).toBe(79.75);
    expect(metrics[1]?.avg).toBe(18.35);
  });
});
