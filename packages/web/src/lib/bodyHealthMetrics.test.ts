import { UnitConverter } from "@dofek/format/units";
import { describe, expect, it } from "vitest";
import { buildBodyHealthMetrics } from "./bodyHealthMetrics.ts";

const units = new UnitConverter("metric");

function buildMetrics(overrides: Partial<Parameters<typeof buildBodyHealthMetrics>[0]> = {}) {
  return buildBodyHealthMetrics({
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
    units,
    ...overrides,
  });
}

describe("buildBodyHealthMetrics", () => {
  it("includes body weight, body fat %, and resting heart rate", () => {
    const metrics = buildMetrics();

    expect(metrics.map((metric) => metric.label)).toEqual([
      "Trend Weight",
      "Body Fat %",
      "Resting Heart Rate",
    ]);
    expect(metrics[0]).toMatchObject({
      value: 80.1,
      avg: expect.closeTo(80.7, 2),
      stddev: expect.closeTo(0.557, 2),
      lowerBetter: true,
    });
    expect(metrics[1]).toMatchObject({
      value: 18.8,
      avg: expect.closeTo(19.133, 2),
      stddev: expect.closeTo(0.351, 2),
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
    const metrics = buildMetrics({
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
    });

    expect(metrics[0]?.avg).toBe(79.75);
    expect(metrics[1]?.avg).toBe(18.35);
  });

  it("excludes boundary and out-of-window measurements from averages", () => {
    const metrics = buildMetrics({
      weightData: [
        { date: "2026-05-31", smoothedWeight: 100 },
        { date: "2026-06-15", smoothedWeight: 80 },
        { date: "2026-07-01", smoothedWeight: 99 },
      ],
      recompData: [
        { date: "2026-05-31", bodyFatPct: 30 },
        { date: "2026-06-15", bodyFatPct: 18 },
        { date: "2026-07-01", bodyFatPct: 12 },
      ],
    });

    expect(metrics[0]?.avg).toBe(80);
    expect(metrics[1]?.avg).toBe(18);
  });

  it("excludes measurements after the selected end date for all-time ranges", () => {
    const metrics = buildMetrics({
      days: null,
      weightData: [
        { date: "2026-06-01", smoothedWeight: 81 },
        { date: "2026-06-30", smoothedWeight: 80 },
        { date: "2026-07-01", smoothedWeight: 60 },
      ],
      recompData: [
        { date: "2026-06-01", bodyFatPct: 19 },
        { date: "2026-06-30", bodyFatPct: 18 },
        { date: "2026-07-01", bodyFatPct: 10 },
      ],
    });

    expect(metrics[0]?.value).toBe(80);
    expect(metrics[0]?.avg).toBe(80.5);
    expect(metrics[1]?.value).toBe(18);
    expect(metrics[1]?.avg).toBe(18.5);
  });

  it("returns null body metrics when the selected window has no measurements", () => {
    const metrics = buildMetrics({
      weightData: [{ date: "2026-01-01", smoothedWeight: 90 }],
      recompData: [{ date: "2026-01-01", bodyFatPct: 25 }],
    });

    expect(metrics[0]?.value).toBeNull();
    expect(metrics[0]?.avg).toBeNull();
    expect(metrics[0]?.stddev).toBeNull();
    expect(metrics[1]?.value).toBeNull();
    expect(metrics[1]?.avg).toBeNull();
    expect(metrics[1]?.stddev).toBeNull();
  });

  it("returns null body metrics when no measurements exist", () => {
    const metrics = buildMetrics({
      weightData: [],
      recompData: [],
    });

    expect(metrics[0]?.value).toBeNull();
    expect(metrics[0]?.avg).toBeNull();
    expect(metrics[0]?.stddev).toBeNull();
    expect(metrics[1]?.value).toBeNull();
    expect(metrics[1]?.avg).toBeNull();
    expect(metrics[1]?.stddev).toBeNull();
  });

  it("returns null resting heart rate when trend data is missing", () => {
    const metrics = buildMetrics({ trendData: undefined });

    expect(metrics[2]?.value).toBeNull();
    expect(metrics[2]?.avg).toBeNull();
    expect(metrics[2]?.stddev).toBeNull();
  });

  it("returns null stddev for a single in-window measurement", () => {
    const metrics = buildMetrics({
      weightData: [{ date: "2026-06-15", smoothedWeight: 80 }],
      recompData: [{ date: "2026-06-15", bodyFatPct: 18 }],
    });

    expect(metrics[0]?.stddev).toBeNull();
    expect(metrics[1]?.stddev).toBeNull();
  });

  it("formats body weight with the provided unit converter", () => {
    const metrics = buildMetrics();
    const weightMetric = metrics[0];

    expect(weightMetric?.formatValue?.(80.5)).toEqual(units.formatWeight(80.5));
  });
});
