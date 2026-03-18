import { describe, expect, it } from "vitest";
import { average, maxVal, summarizeSegment } from "./intervals.ts";

describe("average", () => {
  it("computes average of positive values", () => {
    expect(average([100, 200, 300])).toBe(200);
  });

  it("returns null for empty array", () => {
    expect(average([])).toBeNull();
  });

  it("returns null for all-null array", () => {
    expect(average([null, null])).toBeNull();
  });

  it("ignores null values", () => {
    expect(average([100, null, 200])).toBe(150);
  });

  it("ignores zero values", () => {
    expect(average([0, 100, 200])).toBe(150);
  });

  it("rounds to 1 decimal place", () => {
    expect(average([100, 200, 201])).toBe(167);
  });

  it("returns single value when only one valid", () => {
    expect(average([null, 150, null])).toBe(150);
  });
});

describe("maxVal", () => {
  it("returns max of positive values", () => {
    expect(maxVal([100, 200, 300])).toBe(300);
  });

  it("returns null for empty array", () => {
    expect(maxVal([])).toBeNull();
  });

  it("returns null for all-null array", () => {
    expect(maxVal([null, null])).toBeNull();
  });

  it("ignores null values", () => {
    expect(maxVal([null, 200, null, 100])).toBe(200);
  });

  it("handles single value", () => {
    expect(maxVal([42])).toBe(42);
  });

  it("handles negative values", () => {
    expect(maxVal([-5, -10, -1])).toBe(-1);
  });
});

describe("summarizeSegment", () => {
  const makeRows = (overrides: Partial<Parameters<typeof summarizeSegment>[0][number]> = {}) => [
    {
      avg_power: 200 as number | null,
      avg_hr: 140 as number | null,
      avg_speed: 8.5 as number | null,
      avg_cadence: 85 as number | null,
      max_power: 250 as number | null,
      max_hr: 155 as number | null,
      max_speed: 10.0 as number | null,
      ...overrides,
    },
    {
      avg_power: 210 as number | null,
      avg_hr: 145 as number | null,
      avg_speed: 8.7 as number | null,
      avg_cadence: 88 as number | null,
      max_power: 260 as number | null,
      max_hr: 160 as number | null,
      max_speed: 10.5 as number | null,
      ...overrides,
    },
  ];

  it("computes avg and max metrics from segment rows", () => {
    const result = summarizeSegment(
      makeRows(),
      { minute_start: "2026-03-01T10:00:00" },
      { minute_start: "2026-03-01T10:01:00" },
    );

    expect(result.startedAt).toBe("2026-03-01T10:00:00");
    expect(result.endedAt).toBe("2026-03-01T10:01:00");
    expect(result.avgPower).toBe(205);
    expect(result.avgHeartRate).toBe(142.5);
    expect(result.avgSpeed).toBe(8.6);
    expect(result.avgCadence).toBe(86.5);
    expect(result.maxPower).toBe(260);
    expect(result.maxHeartRate).toBe(160);
    expect(result.maxSpeed).toBe(10.5);
  });

  it("returns null for metrics when all values are null", () => {
    const rows = [
      {
        avg_power: null,
        avg_hr: null,
        avg_speed: null,
        avg_cadence: null,
        max_power: null,
        max_hr: null,
        max_speed: null,
      },
    ];
    const result = summarizeSegment(
      rows,
      { minute_start: "2026-03-01T10:00:00" },
      { minute_start: "2026-03-01T10:01:00" },
    );

    expect(result.avgPower).toBeNull();
    expect(result.avgHeartRate).toBeNull();
    expect(result.avgSpeed).toBeNull();
    expect(result.avgCadence).toBeNull();
    expect(result.maxPower).toBeNull();
    expect(result.maxHeartRate).toBeNull();
    expect(result.maxSpeed).toBeNull();
  });

  it("rounds maxHeartRate to integer", () => {
    const rows = [
      {
        avg_power: null,
        avg_hr: null,
        avg_speed: null,
        avg_cadence: null,
        max_power: null,
        max_hr: 155.7,
        max_speed: null,
      },
    ];
    const result = summarizeSegment(
      rows,
      { minute_start: "2026-03-01T10:00:00" },
      { minute_start: "2026-03-01T10:01:00" },
    );
    expect(result.maxHeartRate).toBe(156);
  });

  it("converts minute_start to string via String()", () => {
    const result = summarizeSegment(
      makeRows(),
      { minute_start: "2026-03-01T10:00:00+00:00" },
      { minute_start: "2026-03-01T10:05:00+00:00" },
    );
    expect(result.startedAt).toBe("2026-03-01T10:00:00+00:00");
    expect(result.endedAt).toBe("2026-03-01T10:05:00+00:00");
  });
});
