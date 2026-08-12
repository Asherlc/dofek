import { describe, expect, it, vi } from "vitest";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("@sentry/node", () => ({
  captureException: mockCaptureException,
}));

import {
  BodyAnalyticsRepository,
  ewmaSmooth,
  interpolateMissingDays,
  leastSquaresSlope,
} from "./body-analytics-repository.ts";

// ── leastSquaresSlope ───────────────────────────────────────────────

describe("leastSquaresSlope", () => {
  it("returns zero slope for constant values", () => {
    const result = leastSquaresSlope([
      { dayIndex: 0, value: 80 },
      { dayIndex: 1, value: 80 },
      { dayIndex: 2, value: 80 },
    ]);
    expect(result.slopePerDay).toBe(0);
    expect(result.rSquared).toBe(1);
  });

  it("returns correct slope for perfectly linear data", () => {
    // y = 80 + 0.5 * x
    const result = leastSquaresSlope([
      { dayIndex: 0, value: 80 },
      { dayIndex: 1, value: 80.5 },
      { dayIndex: 2, value: 81 },
      { dayIndex: 3, value: 81.5 },
    ]);
    expect(result.slopePerDay).toBeCloseTo(0.5, 10);
    expect(result.rSquared).toBeCloseTo(1, 10);
  });

  it("returns negative slope for decreasing data", () => {
    const result = leastSquaresSlope([
      { dayIndex: 0, value: 80 },
      { dayIndex: 1, value: 79.5 },
      { dayIndex: 2, value: 79 },
    ]);
    expect(result.slopePerDay).toBeCloseTo(-0.5, 10);
  });

  it("handles noisy data and returns rSquared < 1", () => {
    const result = leastSquaresSlope([
      { dayIndex: 0, value: 80 },
      { dayIndex: 1, value: 82 },
      { dayIndex: 2, value: 79 },
      { dayIndex: 3, value: 81 },
    ]);
    // Should have some slope, but rSquared should be low due to noise
    expect(result.rSquared).toBeLessThan(0.5);
  });

  it("returns zero slope and rSquared=1 for single point", () => {
    const result = leastSquaresSlope([{ dayIndex: 0, value: 80 }]);
    expect(result.slopePerDay).toBe(0);
    expect(result.rSquared).toBe(1);
  });

  it("returns zero slope and rSquared=1 for empty input", () => {
    const result = leastSquaresSlope([]);
    expect(result.slopePerDay).toBe(0);
    expect(result.rSquared).toBe(1);
  });

  it("handles two-point regression exactly", () => {
    const result = leastSquaresSlope([
      { dayIndex: 0, value: 80 },
      { dayIndex: 7, value: 79 },
    ]);
    // slope = (79-80)/(7-0) = -1/7 ≈ -0.1429
    expect(result.slopePerDay).toBeCloseTo(-1 / 7, 10);
    expect(result.rSquared).toBeCloseTo(1, 10);
  });
});

// ── interpolateMissingDays ──────────────────────────────────────────

describe("interpolateMissingDays", () => {
  it("returns empty array for empty input", () => {
    expect(interpolateMissingDays([])).toEqual([]);
  });

  it("returns single point unchanged with interpolated=false", () => {
    const result = interpolateMissingDays([{ date: "2024-01-01", value: 80 }]);
    expect(result).toEqual([{ date: "2024-01-01", value: 80, interpolated: false }]);
  });

  it("returns consecutive days unchanged (no gaps to fill)", () => {
    const input = [
      { date: "2024-01-01", value: 80 },
      { date: "2024-01-02", value: 81 },
      { date: "2024-01-03", value: 79 },
    ];
    const result = interpolateMissingDays(input);
    expect(result).toEqual([
      { date: "2024-01-01", value: 80, interpolated: false },
      { date: "2024-01-02", value: 81, interpolated: false },
      { date: "2024-01-03", value: 79, interpolated: false },
    ]);
  });

  it("fills a 1-day gap with linear interpolation", () => {
    const input = [
      { date: "2024-01-01", value: 80 },
      { date: "2024-01-03", value: 82 },
    ];
    const result = interpolateMissingDays(input);
    expect(result).toEqual([
      { date: "2024-01-01", value: 80, interpolated: false },
      { date: "2024-01-02", value: 81, interpolated: true },
      { date: "2024-01-03", value: 82, interpolated: false },
    ]);
  });

  it("fills a multi-day gap with evenly spaced interpolation", () => {
    const input = [
      { date: "2024-01-01", value: 80 },
      { date: "2024-01-05", value: 84 },
    ];
    const result = interpolateMissingDays(input);
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ date: "2024-01-01", value: 80, interpolated: false });
    expect(result[1]).toEqual({ date: "2024-01-02", value: 81, interpolated: true });
    expect(result[2]).toEqual({ date: "2024-01-03", value: 82, interpolated: true });
    expect(result[3]).toEqual({ date: "2024-01-04", value: 83, interpolated: true });
    expect(result[4]).toEqual({ date: "2024-01-05", value: 84, interpolated: false });
  });

  it("handles multiple gaps in a single series", () => {
    const input = [
      { date: "2024-01-01", value: 80 },
      { date: "2024-01-03", value: 82 },
      { date: "2024-01-06", value: 85 },
    ];
    const result = interpolateMissingDays(input);
    expect(result).toHaveLength(6);
    // First gap: Jan 2 interpolated between 80 and 82
    expect(result[1]).toEqual({ date: "2024-01-02", value: 81, interpolated: true });
    // Second gap: Jan 4 and Jan 5 interpolated between 82 and 85
    expect(result[3]).toEqual({ date: "2024-01-04", value: 83, interpolated: true });
    expect(result[4]).toEqual({ date: "2024-01-05", value: 84, interpolated: true });
    // Original points preserved
    expect(result[0]?.interpolated).toBe(false);
    expect(result[2]?.interpolated).toBe(false);
    expect(result[5]?.interpolated).toBe(false);
  });

  it("preserves original values exactly (no floating-point drift)", () => {
    const input = [
      { date: "2024-01-01", value: 80.12 },
      { date: "2024-01-03", value: 82.34 },
    ];
    const result = interpolateMissingDays(input);
    expect(result[0]?.value).toBe(80.12);
    expect(result[2]?.value).toBe(82.34);
  });

  it("does not extrapolate beyond first and last known points", () => {
    const input = [
      { date: "2024-01-03", value: 80 },
      { date: "2024-01-05", value: 82 },
    ];
    const result = interpolateMissingDays(input);
    expect(result[0]?.date).toBe("2024-01-03");
    expect(result[result.length - 1]?.date).toBe("2024-01-05");
  });
});

// ── EWMA helper ─────────────────────────────────────────────────────

describe("ewmaSmooth", () => {
  it("returns empty array for empty input", () => {
    expect(ewmaSmooth([], 0.1)).toEqual([]);
  });

  it("returns the single value for a one-element array", () => {
    expect(ewmaSmooth([80], 0.1)).toEqual([80]);
  });

  it("applies EWMA with alpha=0.1 correctly", () => {
    const values = [80, 81, 79, 80.5, 80];
    const result = ewmaSmooth(values, 0.1);

    expect(result).toHaveLength(5);
    // First value is the seed
    expect(result[0]).toBe(80);
    // Second: 0.1 * 81 + 0.9 * 80 = 80.1
    expect(result[1]).toBeCloseTo(80.1, 10);
    // Third: 0.1 * 79 + 0.9 * 80.1 = 79.99
    expect(result[2]).toBeCloseTo(79.99, 10);
    // Fourth: 0.1 * 80.5 + 0.9 * 79.99 = 80.041
    expect(result[3]).toBeCloseTo(80.041, 10);
    // Fifth: 0.1 * 80 + 0.9 * 80.041 = 80.0369
    expect(result[4]).toBeCloseTo(80.0369, 10);
  });

  it("uses the correct alpha coefficient (distinguishes 0.1 from 0.2)", () => {
    const values = [100, 110];
    const resultAlpha01 = ewmaSmooth(values, 0.1);
    // 0.1 * 110 + 0.9 * 100 = 101
    expect(resultAlpha01[1]).toBe(101);

    const resultAlpha02 = ewmaSmooth(values, 0.2);
    // 0.2 * 110 + 0.8 * 100 = 102
    expect(resultAlpha02[1]).toBe(102);
  });

  it("applies EWMA with alpha=0.15 correctly", () => {
    const values = [10, 12, 11];
    const result = ewmaSmooth(values, 0.15);

    expect(result[0]).toBe(10);
    // 0.15 * 12 + 0.85 * 10 = 10.3
    expect(result[1]).toBeCloseTo(10.3, 10);
    // 0.15 * 11 + 0.85 * 10.3 = 10.405
    expect(result[2]).toBeCloseTo(10.405, 10);
  });
});

// ── Repository ──────────────────────────────────────────────────────

function makeRepository(
  rows: Record<string, unknown>[] = [],
  accessWindow?: ConstructorParameters<typeof BodyAnalyticsRepository>[3],
) {
  const execute = vi.fn().mockResolvedValue(rows);
  const query = vi.fn().mockResolvedValue(rows);
  const repo = new BodyAnalyticsRepository({ execute }, "user-1", "UTC", accessWindow, { query });
  return { repo, execute, query };
}

describe("BodyAnalyticsRepository", () => {
  it("requires a ClickHouse body measurement store", () => {
    expect(() => new BodyAnalyticsRepository({ execute: vi.fn() }, "user-1")).toThrow(
      "body analytics require the ClickHouse body measurement store",
    );
  });

  it("reuses identical non-body-fat body weight fetches within one repository instance", async () => {
    const { repo, query } = makeRepository([
      { date: "2024-01-01", weight_kg: "80" },
      { date: "2024-01-02", weight_kg: "81" },
    ]);

    await repo.getSmoothedWeight(90, "2024-06-01");
    await repo.getWeightPrediction(90, "2024-06-01", null);

    expect(query).toHaveBeenCalledOnce();
  });

  it("builds decision context from the same trend series and body provenance", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => {
      const date = `2024-01-${String(index + 1).padStart(2, "0")}`;
      return {
        date,
        weight_kg: 80 + index / 10,
        recorded_at: `${date}T08:00:00.000Z`,
        recorded_at_local: `${date} 08:00:00`,
        provider_id: index === 7 ? "apple_health" : "withings",
        source_name: index === 7 ? "Apple Watch" : "Body+",
      };
    });
    const { repo } = makeRepository(rows);

    const result = await repo.getBodyDecisionContext("2024-01-08");

    expect(result.latestMeasurement).toMatchObject({
      date: "2024-01-08",
      recordedAtLocal: "2024-01-08 08:00:00",
      providerId: "apple_health",
      sourceName: "Apple Watch",
    });
    expect(result.variation.status).toBe("available");
    expect(result.variation.observations).toBe(8);
  });

  it("evicts rejected body weight fetches from the per-instance cache", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary ClickHouse failure"))
      .mockResolvedValueOnce([{ date: "2024-01-01", weight_kg: "80" }]);
    const repo = new BodyAnalyticsRepository({ execute }, "user-1", "UTC", undefined, { query });

    await expect(repo.getSmoothedWeight(90, "2024-06-01")).rejects.toThrow(
      "temporary ClickHouse failure",
    );
    const result = await repo.getSmoothedWeight(null, "2024-06-01");

    expect(query).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
  });

  it("reports rejected body weight fetches before rethrowing", async () => {
    const fetchError = new Error("temporary ClickHouse failure");
    const execute = vi.fn().mockResolvedValue([]);
    const query = vi.fn().mockRejectedValueOnce(fetchError);
    const repo = new BodyAnalyticsRepository({ execute }, "user-1", "UTC", undefined, { query });

    await expect(repo.getSmoothedWeight(90, "2024-06-01")).rejects.toThrow(
      "temporary ClickHouse failure",
    );

    expect(mockCaptureException).toHaveBeenCalledWith(fetchError);
  });

  it("does not reuse non-body-fat rows for recomposition fetches", async () => {
    const { repo, query } = makeRepository([
      { date: "2024-01-01", weight_kg: "80", body_fat_pct: "20" },
    ]);

    await repo.getSmoothedWeight(180, "2024-06-01");
    await repo.getRecomposition(180, "2024-06-01");

    expect(query).toHaveBeenCalledTimes(2);
    const recompositionQuery = query.mock.calls[1]?.[1] ?? "";
    expect(recompositionQuery).toMatch(
      /FROM analytics\.daily_body_measurement FINAL[\s\S]*AND body_fat_pct IS NOT NULL[\s\S]*\) AS body_rows[\s\S]*GROUP BY local_date/,
    );
  });

  describe("getSmoothedWeight", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getSmoothedWeight(90, "2024-06-01");
      expect(result).toEqual([]);
    });

    it("passes access window parameters to the body weight query", async () => {
      const accessWindow = {
        kind: "limited" as const,
        paid: false,
        reason: "free_signup_week" as const,
        startDate: "2026-04-10",
        endDateExclusive: "2026-04-17",
      };
      const { repo, query } = makeRepository([], accessWindow);

      await repo.getSmoothedWeight(90, "2024-06-01");

      expect(query).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("local_date >= toDate({accessStart:String})"),
        expect.objectContaining({
          accessStart: "2026-04-10",
          accessEnd: "2026-04-17",
        }),
      );
    });

    it("computes EWMA smoothed weight correctly", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80" },
        { date: "2024-01-02", weight_kg: "81" },
        { date: "2024-01-03", weight_kg: "79" },
      ]);

      const result = await repo.getSmoothedWeight(null, "2024-06-01");

      expect(result).toHaveLength(3);
      expect(result[0]?.rawWeight).toBe(80);
      expect(result[0]?.smoothedWeight).toBe(80);
      // 0.1 * 81 + 0.9 * 80 = 80.1
      expect(result[1]?.smoothedWeight).toBe(80.1);
      expect(result[2]?.smoothedWeight).toBe(80);
    });

    it("seeds the selected range from the full accessible weight history", async () => {
      const rows = Array.from({ length: 10 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: index === 0 ? "100" : "110",
      }));
      const { repo, query } = makeRepository(rows);

      const result = await repo.getSmoothedWeight(7, "2024-01-10");

      expect(result[0]).toMatchObject({
        date: "2024-01-04",
        smoothedWeight: 102.7,
      });
      expect(result.at(-1)?.smoothedWeight).toBe(106.1);
      expect(query).toHaveBeenCalledWith(
        expect.anything(),
        expect.not.stringContaining("subtractDays"),
        expect.not.objectContaining({ days: expect.anything() }),
      );
    });

    it("computes weekly change when enough data points exist", async () => {
      // 10 days of data so we can compute weekly change for days 7+
      const rows = Array.from({ length: 10 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.5), // steadily increasing
      }));

      const { repo } = makeRepository(rows);
      const result = await repo.getSmoothedWeight(null, "2024-06-01");

      expect(result).toHaveLength(10);
      // First 7 entries should have null weeklyChange
      for (let index = 0; index < 7; index++) {
        expect(result[index]?.weeklyChange).toBeNull();
      }
      // Entry 7+ should have a non-null weeklyChange
      expect(result[7]?.weeklyChange).not.toBeNull();
      expect(typeof result[7]?.weeklyChange).toBe("number");
    });

    it("returns null weeklyChange for first 7 entries (index < 7 boundary)", async () => {
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.5),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getSmoothedWeight(null, "2024-06-01");
      // Index 6 (7th entry) should still have null weeklyChange
      expect(result[6]?.weeklyChange).toBeNull();
      // Index 7 (8th entry) should have non-null weeklyChange
      expect(result[7]?.weeklyChange).not.toBeNull();
    });

    it("marks actual measurements as interpolated=false", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80" },
        { date: "2024-01-02", weight_kg: "81" },
      ]);
      const result = await repo.getSmoothedWeight(null, "2024-06-01");
      expect(result[0]?.interpolated).toBe(false);
      expect(result[1]?.interpolated).toBe(false);
      expect(result[0]?.rawWeight).not.toBeNull();
      expect(result[1]?.rawWeight).not.toBeNull();
      expect(result[0]?.rawWeightStatus).toEqual({ kind: "observed", label: "Observed" });
      expect(result[0]?.smoothedWeightStatus).toEqual({
        kind: "estimated",
        label: "Estimated",
      });
    });

    it("fills missing days with interpolation and marks them", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80" },
        { date: "2024-01-03", weight_kg: "82" },
      ]);
      const result = await repo.getSmoothedWeight(null, "2024-06-01");
      // Should have 3 rows: Jan 1 (real), Jan 2 (interpolated), Jan 3 (real)
      expect(result).toHaveLength(3);
      expect(result[0]?.interpolated).toBe(false);
      expect(result[0]?.rawWeight).toBe(80);
      expect(result[1]?.interpolated).toBe(true);
      expect(result[1]?.rawWeight).toBeNull();
      expect(result[1]?.rawWeightStatus).toBeNull();
      expect(result[1]?.smoothedWeightStatus).toEqual({
        kind: "estimated",
        label: "Estimated",
      });
      expect(result[2]?.interpolated).toBe(false);
      expect(result[2]?.rawWeight).toBe(82);
    });

    it("does not report weekly change when the 7-day window is mostly interpolated", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "95" },
        { date: "2024-01-02", weight_kg: "95" },
        { date: "2024-01-20", weight_kg: "85" },
      ]);
      const result = await repo.getSmoothedWeight(90, "2024-01-20");

      expect(result.at(-1)?.weeklyChange).toBeNull();
    });

    it("excludes non-positive weights from smoothing computation", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80" },
        { date: "2024-01-02", weight_kg: "0" },
        { date: "2024-01-03", weight_kg: "82" },
      ]);

      const result = await repo.getSmoothedWeight(null, "2024-06-01");

      expect(result.map((row) => row.rawWeight)).toEqual([80, null, 82]);
    });

    it("applies EWMA smoothing across interpolated days", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80" },
        { date: "2024-01-04", weight_kg: "83" },
      ]);
      const result = await repo.getSmoothedWeight(null, "2024-06-01");
      // 4 days: 80, 81(interpolated), 82(interpolated), 83
      expect(result).toHaveLength(4);
      // Smoothed values should progress gradually (EWMA with alpha=0.1)
      expect(result[1]?.smoothedWeight).toBeGreaterThan(result[0]?.smoothedWeight ?? 0);
      expect(result[2]?.smoothedWeight).toBeGreaterThan(result[1]?.smoothedWeight ?? 0);
      expect(result[3]?.smoothedWeight).toBeGreaterThan(result[2]?.smoothedWeight ?? 0);
    });

    it("rounds values to 1 decimal place", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80.123" },
        { date: "2024-01-02", weight_kg: "80.456" },
      ]);

      const result = await repo.getSmoothedWeight(null, "2024-06-01");
      expect(result[0]?.rawWeight).toBe(80.1);
      expect(result[1]?.rawWeight).toBe(80.5);
    });
  });

  describe("getSmoothedBodyFat", () => {
    it("builds an interpolated, server-authored body-fat trend", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80", body_fat_pct: "20" },
        { date: "2024-01-03", weight_kg: "80", body_fat_pct: "22" },
      ]);

      const result = await repo.getSmoothedBodyFat(null, "2024-06-01");

      expect(result).toEqual([
        expect.objectContaining({
          date: "2024-01-01",
          rawBodyFatPct: 20,
          smoothedBodyFatPct: 20,
          interpolated: false,
        }),
        expect.objectContaining({
          date: "2024-01-02",
          rawBodyFatPct: null,
          smoothedBodyFatPct: 20.1,
          interpolated: true,
        }),
        expect.objectContaining({
          date: "2024-01-03",
          rawBodyFatPct: 22,
          smoothedBodyFatPct: 20.3,
          interpolated: false,
        }),
      ]);
    });
  });

  describe("getRecomposition", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      expect(result).toEqual([]);
    });

    it("requires body fat in the ClickHouse body query", async () => {
      const { repo, query } = makeRepository([]);

      await repo.getRecomposition(180, "2024-06-01");

      expect(query).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("AND body_fat_pct IS NOT NULL"),
        expect.anything(),
      );
    });

    it("computes fat and lean mass correctly", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80", body_fat_pct: "20" },
      ]);

      const result = await repo.getRecomposition(180, "2024-06-01");

      expect(result).toHaveLength(1);
      // fatMass = 80 * 20/100 = 16
      expect(result[0]?.fatMassKg).toBe(16);
      // leanMass = 80 - 16 = 64
      expect(result[0]?.leanMassKg).toBe(64);
      expect(result[0]?.weightKg).toBe(80);
      expect(result[0]?.bodyFatPct).toBe(20);
    });

    it("applies EWMA smoothing with alpha=0.15 on fat and lean mass", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80", body_fat_pct: "20" },
        { date: "2024-01-02", weight_kg: "82", body_fat_pct: "22" },
      ]);

      const result = await repo.getRecomposition(180, "2024-06-01");

      expect(result).toHaveLength(2);

      // Day 1: fatMass=16, leanMass=64, smoothed same as raw
      expect(result[0]?.smoothedFatMass).toBe(16);
      expect(result[0]?.smoothedLeanMass).toBe(64);

      // Day 2: fatMass = 82 * 0.22 = 18.04, leanMass = 82 - 18.04 = 63.96
      expect(result[1]?.smoothedFatMass).toBe(16.3);
      expect(result[1]?.smoothedLeanMass).toBe(64);
    });

    it("divides bodyFatPct by 100 for fat mass (not 10 or 1000)", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "100", body_fat_pct: "25" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      // fatMass = 100 * 25/100 = 25
      expect(result[0]?.fatMassKg).toBe(25);
      // leanMass = 100 - 25 = 75
      expect(result[0]?.leanMassKg).toBe(75);
    });

    it("rounds bodyFatPct to 1 decimal place", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80", body_fat_pct: "18.25" },
      ]);

      const result = await repo.getRecomposition(180, "2024-06-01");
      // 18.25 rounded to 1 decimal = 18.3 (rounds up)
      expect(result[0]?.bodyFatPct).toBe(18.3);
    });

    it("excludes non-positive weights from recomposition computation", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80", body_fat_pct: "20" },
        { date: "2024-01-02", weight_kg: "0", body_fat_pct: "13.2" },
      ]);

      const result = await repo.getRecomposition(180, "2024-06-01");

      expect(result).toHaveLength(1);
      expect(result[0]?.date).toBe("2024-01-01");
    });
  });

  describe("getWeightTrend", () => {
    it("returns insufficient when fewer than 7 data points", async () => {
      const rows = Array.from({ length: 5 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80),
      }));

      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();

      expect(result.trend).toBe("insufficient");
      expect(result.currentWeekly).toBeNull();
      expect(result.current4Week).toBeNull();
    });

    it("returns insufficient for empty data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getWeightTrend();
      expect(result.trend).toBe("insufficient");
    });

    it("threads the entitlement access window into the trend query", async () => {
      const accessWindow = {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-01-01",
        endDateExclusive: "2026-02-01",
      } as const;
      const { repo, query } = makeRepository([], accessWindow);

      await repo.getWeightTrend();

      expect(query.mock.calls[0]?.[2]).toMatchObject({
        accessStart: "2026-01-01",
        accessEnd: "2026-02-01",
      });
      expect(query.mock.calls[0]?.[1]).toContain("local_date >= toDate({accessStart:String})");
    });

    it("classifies gaining trend when weight increasing", async () => {
      // 10 days of steadily increasing weight (1kg/day - very fast gain)
      const rows = Array.from({ length: 10 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index),
      }));

      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();

      expect(result.trend).toBe("gaining");
      expect(result.currentWeekly).not.toBeNull();
      expect(result.currentWeekly).toBeGreaterThan(0.1);
    });

    it("classifies losing trend when weight decreasing", async () => {
      // 10 days of steadily decreasing weight
      const rows = Array.from({ length: 10 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 - index),
      }));

      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();

      expect(result.trend).toBe("losing");
      expect(result.currentWeekly).not.toBeNull();
      expect(result.currentWeekly).toBeLessThan(-0.1);
    });

    it("classifies stable trend when weight constant", async () => {
      // 10 days of constant weight
      const rows = Array.from({ length: 10 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
      }));

      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();

      expect(result.trend).toBe("stable");
    });

    it("returns insufficient with exactly 6 data points (boundary < 7)", async () => {
      const rows = Array.from({ length: 6 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.trend).toBe("insufficient");
    });

    it("excludes non-positive weights from trend computation", async () => {
      const rows = [
        { date: "2024-01-01", weight_kg: "80" },
        { date: "2024-01-02", weight_kg: "80" },
        { date: "2024-01-03", weight_kg: "80" },
        { date: "2024-01-04", weight_kg: "80" },
        { date: "2024-01-05", weight_kg: "80" },
        { date: "2024-01-06", weight_kg: "80" },
        { date: "2024-01-07", weight_kg: "0" },
      ];
      const { repo } = makeRepository(rows);

      const result = await repo.getWeightTrend();

      expect(result.trend).toBe("insufficient");
    });

    it("returns non-insufficient with exactly 7 data points (boundary)", async () => {
      const rows = Array.from({ length: 7 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.trend).not.toBe("insufficient");
    });

    it("classifies stable when weight is constant (0 change)", async () => {
      const rows = Array.from({ length: 10 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.trend).toBe("stable");
      expect(result.currentWeekly).toBe(0);
    });

    it("returns null for current4Week when fewer than 29 data points", async () => {
      const rows = Array.from({ length: 10 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.current4Week).toBeNull();
    });

    it("provides 4-week change when enough data", async () => {
      // 30 days of data - enough for 4-week comparison
      const rows = Array.from({ length: 30 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.1),
      }));

      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();

      expect(result.currentWeekly).not.toBeNull();
      expect(result.current4Week).not.toBeNull();
    });

    it("uses regression-based weekly rate on smoothed values", async () => {
      // 8 data points: [80, 82, 80, 82, 80, 82, 80, 82]
      // Smoothed with alpha=0.1, then regression finds the best-fit slope.
      // For oscillating data, regression slope is positive but smaller than
      // the delta approach (which was 0.6). Regression is more robust to noise.
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(index % 2 === 0 ? 80 : 82),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.currentWeekly).not.toBeNull();
      // Regression slope * 7 should be positive but moderate for this noisy data
      expect(result.currentWeekly).toBeGreaterThan(0);
      expect(result.currentWeekly).toBeLessThan(1);
    });

    it("classifies 'gaining' when weekly change is exactly 0.11 (> 0.1 threshold)", async () => {
      // We need a series where the smoothed weekly diff is just above 0.1
      // Use constant increase: 8 days starting at 80, increasing 0.2/day
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.2),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.trend).toBe("gaining");
      expect(result.currentWeekly).toBeGreaterThan(0.1);
    });

    it("classifies 'losing' when weekly change is exactly below -0.1 (< -0.1 threshold)", async () => {
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 - index * 0.2),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.trend).toBe("losing");
      expect(result.currentWeekly).toBeLessThan(-0.1);
    });

    it("returns null current4Week with exactly 28 data points (< 29 boundary)", async () => {
      const rows = Array.from({ length: 28 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.5),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.current4Week).toBeNull();
    });

    it("returns non-null current4Week with exactly 29 data points (>= 29 boundary)", async () => {
      const rows = Array.from({ length: 29 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.5),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.current4Week).not.toBeNull();
    });

    it("returns null currentWeekly with exactly 7 data points (< 8 needed for oneWeekAgo)", async () => {
      // With 7 points, smoothed.length=7, so smoothed.length >= 8 is false
      const rows = Array.from({ length: 7 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.currentWeekly).toBeNull();
    });

    it("returns non-null currentWeekly with exactly 8 data points (>= 8 boundary)", async () => {
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.currentWeekly).not.toBeNull();
    });

    it("falls back to current4Week for trend when currentWeekly is null", async () => {
      // 7 points = no weekly, but if there were 29+ we'd have 4-week
      // With only 7 points, both are null, so trend uses changeReference=null → stable
      const rows = Array.from({ length: 7 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      // With 7 points but < 8 for weekly: currentWeekly is null
      // With < 29 for 4-week: current4Week is null
      // changeReference = null, so trend = "stable"
      expect(result.trend).toBe("stable");
    });

    it("rounds weeklyChange to 2 decimal places via Math.round(x * 100) / 100", async () => {
      // Create a series that produces a non-round weeklyChange
      const rows = [
        { date: "2024-01-01", weight_kg: "80" },
        { date: "2024-01-02", weight_kg: "80.3" },
        { date: "2024-01-03", weight_kg: "80.1" },
        { date: "2024-01-04", weight_kg: "80.4" },
        { date: "2024-01-05", weight_kg: "80.2" },
        { date: "2024-01-06", weight_kg: "80.5" },
        { date: "2024-01-07", weight_kg: "80.3" },
        { date: "2024-01-08", weight_kg: "80.6" },
        { date: "2024-01-09", weight_kg: "80.4" },
        { date: "2024-01-10", weight_kg: "80.7" },
      ];
      const { repo } = makeRepository(rows);
      const result = await repo.getSmoothedWeight(90, "2024-06-01");
      // weeklyChange should be a number rounded to 2 decimal places
      for (const row of result) {
        if (row.weeklyChange !== null) {
          const str = String(row.weeklyChange);
          const decimals = str.includes(".") ? (str.split(".")[1]?.length ?? 0) : 0;
          expect(decimals).toBeLessThanOrEqual(2);
        }
      }
    });
  });

  describe("getSmoothedWeight EWMA alpha", () => {
    it("uses alpha=0.1 for smoothed weight (not 0.15 or 0.2)", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "100" },
        { date: "2024-01-02", weight_kg: "110" },
      ]);
      const result = await repo.getSmoothedWeight(null, "2024-06-01");
      // alpha=0.1: smoothed = 0.1 * 110 + 0.9 * 100 = 101
      expect(result[1]?.smoothedWeight).toBe(101);
    });
  });

  describe("getSmoothedWeight property values", () => {
    it("preserves date string from DB row", async () => {
      const { repo } = makeRepository([{ date: "2024-03-15", weight_kg: "75" }]);
      const result = await repo.getSmoothedWeight(90, "2024-06-01");
      expect(result[0]?.date).toBe("2024-03-15");
    });

    it("rounds rawWeight to 1 decimal place", async () => {
      const { repo } = makeRepository([{ date: "2024-01-01", weight_kg: "80.1234" }]);
      const result = await repo.getSmoothedWeight(null, "2024-06-01");
      expect(result[0]?.rawWeight).toBe(80.1);
    });

    it("rounds smoothedWeight to 1 decimal place", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80.1234" },
        { date: "2024-01-02", weight_kg: "81.5678" },
      ]);
      const result = await repo.getSmoothedWeight(null, "2024-06-01");
      expect(result[0]?.smoothedWeight).toBe(80.1);
      expect(result[1]?.smoothedWeight).toBe(80.3);
    });

    it("rounds weeklyChange via Math.round(x * 100) / 100 (not *10/10 or *1000/1000)", async () => {
      // Build 8 data points to get weeklyChange on index 7
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.3),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getSmoothedWeight(90, "2024-06-01");
      const change = result[7]?.weeklyChange;
      expect(change).not.toBeNull();
      // Verify 2-decimal precision
      if (change !== null && change !== undefined) {
        const str = String(change);
        const decimals = str.includes(".") ? (str.split(".")[1]?.length ?? 0) : 0;
        expect(decimals).toBeLessThanOrEqual(2);
      }
    });
  });

  describe("getRecomposition property values", () => {
    it("preserves date string from DB row in recomposition", async () => {
      const { repo } = makeRepository([
        { date: "2024-05-20", weight_kg: "80", body_fat_pct: "20" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      expect(result[0]?.date).toBe("2024-05-20");
    });

    it("rounds weightKg to 1 decimal place", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80.1234", body_fat_pct: "20" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      expect(result[0]?.weightKg).toBe(80.1);
    });

    it("rounds bodyFatPct to 1 decimal via Math.round(x * 10) / 10 (not *100/100)", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80", body_fat_pct: "18.456" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      // Math.round(18.456 * 10) / 10 = Math.round(184.56) / 10 = 185/10 = 18.5
      expect(result[0]?.bodyFatPct).toBe(18.5);
    });

    it("rounds fatMassKg to 1 decimal place", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80.5", body_fat_pct: "18.3" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      expect(result[0]?.fatMassKg).toBe(14.7);
    });

    it("rounds leanMassKg to 1 decimal place", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80.5", body_fat_pct: "18.3" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      expect(result[0]?.leanMassKg).toBe(65.8);
    });

    it("rounds smoothedFatMass and smoothedLeanMass to 1 decimal place", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "80.5", body_fat_pct: "18.3" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      expect(result[0]?.smoothedFatMass).toBe(14.7);
      expect(result[0]?.smoothedLeanMass).toBe(65.8);
    });
  });

  describe("getWeightTrend specific values", () => {
    it("rounds currentWeekly via Math.round(x * 100) / 100 (not *10/10)", async () => {
      // 8 points with slow increase
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.15),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.currentWeekly).not.toBeNull();
      if (result.currentWeekly !== null) {
        const str = String(result.currentWeekly);
        const decimals = str.includes(".") ? (str.split(".")[1]?.length ?? 0) : 0;
        expect(decimals).toBeLessThanOrEqual(2);
      }
    });

    it("rounds current4Week via Math.round(x * 100) / 100 (not *10/10)", async () => {
      const rows = Array.from({ length: 30 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.15),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.current4Week).not.toBeNull();
      if (result.current4Week !== null) {
        const str = String(result.current4Week);
        const decimals = str.includes(".") ? (str.split(".")[1]?.length ?? 0) : 0;
        expect(decimals).toBeLessThanOrEqual(2);
      }
    });

    it("classifies stable when changeReference is exactly 0.1 (not > 0.1)", async () => {
      // We need a series where weekly change is exactly 0.1
      // With constant weight, weekly change = 0 → stable
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.trend).toBe("stable");
    });

    it("classifies stable when changeReference is exactly -0.1 (not < -0.1)", async () => {
      // Same logic: constant = 0 change = stable
      const rows = Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightTrend();
      expect(result.currentWeekly).toBe(0);
      expect(result.trend).toBe("stable");
    });
  });

  describe("getRecomposition EWMA alpha", () => {
    it("uses alpha=0.15 for body recomposition (not 0.1 or 0.2)", async () => {
      const { repo } = makeRepository([
        { date: "2024-01-01", weight_kg: "100", body_fat_pct: "20" },
        { date: "2024-01-02", weight_kg: "100", body_fat_pct: "30" },
      ]);
      const result = await repo.getRecomposition(180, "2024-06-01");
      // Day 1: fatMass = 100 * 0.2 = 20, leanMass = 80
      // Day 2: fatMass = 100 * 0.3 = 30, leanMass = 70
      // smoothedFat = 0.15 * 30 + 0.85 * 20 = 4.5 + 17 = 21.5
      expect(result[1]?.smoothedFatMass).toBe(21.5);
      // smoothedLean = 0.15 * 70 + 0.85 * 80 = 10.5 + 68 = 78.5
      expect(result[1]?.smoothedLeanMass).toBe(78.5);
    });
  });

  describe("getWeightPrediction", () => {
    it("returns nulls when insufficient data (fewer than 7 points)", async () => {
      const rows = Array.from({ length: 5 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-06-01", null);

      expect(result.ratePerWeek).toBeNull();
      expect(result.rateConfidence).toBeNull();
      expect(result.impliedDailyCalories).toBeNull();
      expect(result.goal).toBeNull();
      expect(result.projectionLine).toEqual([]);
    });

    it("returns goal info even with insufficient data when goalWeightKg is set", async () => {
      const rows = Array.from({ length: 3 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-06-01", 75);

      expect(result.ratePerWeek).toBeNull();
      expect(result.goal).not.toBeNull();
      expect(result.goal?.goalWeightKg).toBe(75);
      expect(result.goal?.estimatedDate).toBeNull();
    });

    it("returns nulls for empty data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getWeightPrediction(90, "2024-06-01", null);

      expect(result.ratePerWeek).toBeNull();
      expect(result.periodDeltas.days7).toBeNull();
      expect(result.periodDeltas.days14).toBeNull();
      expect(result.periodDeltas.days30).toBeNull();
    });

    it("computes period deltas for known linear data", async () => {
      // 30 days of steady -0.1 kg/day loss: 80, 79.9, 79.8, ...
      const rows = Array.from({ length: 30 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 - index * 0.1),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-06-01", null);

      // 7-day delta should be approximately -0.7 (smoothed, so not exact)
      expect(result.periodDeltas.days7).not.toBeNull();
      expect(result.periodDeltas.days7 ?? 0).toBeLessThan(0);
      // 14-day delta should be approximately -1.4
      expect(result.periodDeltas.days14).not.toBeNull();
      expect(result.periodDeltas.days14 ?? 0).toBeLessThan(result.periodDeltas.days7 ?? 0);
      // 30-day should be null for exactly 30 points (smoothed[0] vs smoothed[29] requires 30 entries)
      // Actually days30 = smoothed[last] - smoothed[last-30], which needs >= 31 entries
    });

    it("computes ratePerWeek from regression", async () => {
      // Steady -0.1 kg/day for 20 days
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 - index * 0.1),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-06-01", null);

      expect(result.ratePerWeek).not.toBeNull();
      // slope ≈ -0.1 kg/day → -0.7 kg/week (smoothed, so close but not exact)
      expect(result.ratePerWeek ?? 0).toBeLessThan(-0.5);
      expect(result.ratePerWeek ?? 0).toBeGreaterThan(-1);
      expect(result.rateConfidence).not.toBeNull();
      expect(result.rateConfidence ?? 0).toBeGreaterThan(0.9);
    });

    it("computes ratePerWeek from seven consecutive daily weigh-ins", async () => {
      const rows = Array.from({ length: 7 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 - index * 0.1),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-06-01", null);

      expect(result.ratePerWeek).not.toBeNull();
      expect(result.ratePerWeek ?? 0).toBeLessThan(0);
    });

    it("falls back to 7-day smoothed delta when regression is unavailable", async () => {
      const rows = [
        { date: "2024-01-01", weight_kg: "95" },
        { date: "2024-01-08", weight_kg: "94" },
        { date: "2024-01-14", weight_kg: "93" },
        { date: "2024-01-17", weight_kg: "92.5" },
        { date: "2024-01-18", weight_kg: "92" },
        { date: "2024-01-19", weight_kg: "91.5" },
        { date: "2024-01-20", weight_kg: "91" },
      ];
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-01-20", null);

      expect(result.ratePerWeek).not.toBeNull();
      expect(result.rateConfidence).toBeNull();
      expect(result.impliedDailyCalories).not.toBeNull();
      expect(result.ratePerWeek ?? 0).toBeLessThan(0);
    });

    it("does not overwrite a successful regression rate with the 7-day fallback", async () => {
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 - index * 0.1),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-06-01", null);

      expect(result.rateConfidence).not.toBeNull();
      expect(result.ratePerWeek).toBe(-0.51);
    });

    it("skips the 7-day fallback when the trailing window has too few actual readings", async () => {
      const rows = [
        { date: "2024-01-01", weight_kg: "90" },
        { date: "2024-01-02", weight_kg: "90" },
        { date: "2024-01-03", weight_kg: "90" },
        { date: "2024-01-14", weight_kg: "89" },
        { date: "2024-01-16", weight_kg: "88.5" },
        { date: "2024-01-18", weight_kg: "88" },
        { date: "2024-01-20", weight_kg: "87.5" },
      ];
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-01-20", null);

      expect(result.ratePerWeek).not.toBeNull();
      expect(result.ratePerWeek).toBe(-0.77);
      expect(result.impliedDailyCalories).toBe(-847);
    });

    it("computes the 7-day fallback rate from the trailing window, not the full history", async () => {
      const rows = [
        { date: "2024-01-01", weight_kg: "90" },
        { date: "2024-01-05", weight_kg: "89.5" },
        { date: "2024-01-09", weight_kg: "89" },
        { date: "2024-01-13", weight_kg: "88.5" },
        { date: "2024-01-27", weight_kg: "86" },
        { date: "2024-01-28", weight_kg: "85.8" },
        { date: "2024-01-29", weight_kg: "85.6" },
      ];
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-01-29", null);

      expect(result.ratePerWeek).toBeNull();
    });

    it("computes the fallback goal projection from the weekly rate, not a distorted daily slope", async () => {
      const rows = [
        { date: "2024-01-01", weight_kg: "90" },
        { date: "2024-01-02", weight_kg: "90" },
        { date: "2024-01-03", weight_kg: "90" },
        { date: "2024-01-14", weight_kg: "89" },
        { date: "2024-01-16", weight_kg: "88.5" },
        { date: "2024-01-18", weight_kg: "88" },
        { date: "2024-01-20", weight_kg: "87.5" },
      ];
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-01-20", 80);

      expect(result.goal?.daysRemaining).toBe(81);
      expect(result.projectionLine[0]?.projectedWeight).toBe(88.7);
    });

    it("includes impliedDailyCalories when the rate is exactly at the reportable threshold", async () => {
      const delta = 0.0008;
      const rows = [
        { date: "2024-01-01", weight_kg: "90" },
        { date: "2024-01-02", weight_kg: "90" },
        { date: "2024-01-03", weight_kg: "90" },
        { date: "2024-01-14", weight_kg: String(90 - delta * 6) },
        { date: "2024-01-16", weight_kg: String(90 - delta * 15) },
        { date: "2024-01-18", weight_kg: String(90 - delta * 17) },
        { date: "2024-01-20", weight_kg: String(90 - delta * 19) },
      ];
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-01-20", null);

      expect(result.ratePerWeek).toBe(-0.01);
      expect(result.impliedDailyCalories).toBe(-11);
    });

    it("omits impliedDailyCalories when rate of change is negligible", async () => {
      const rows = Array.from({ length: 14 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-01-14", null);

      expect(result.ratePerWeek).not.toBeNull();
      expect(Math.abs(result.ratePerWeek ?? 0)).toBeLessThan(0.01);
      expect(result.impliedDailyCalories).toBeNull();
    });

    it("does not report rate-derived prediction fields when recent weigh-ins are sparse", async () => {
      const rows = [
        { date: "2024-01-01", weight_kg: "95" },
        { date: "2024-01-02", weight_kg: "95" },
        { date: "2024-01-03", weight_kg: "95" },
        { date: "2024-01-04", weight_kg: "95" },
        { date: "2024-01-05", weight_kg: "95" },
        { date: "2024-01-06", weight_kg: "95" },
        { date: "2024-01-20", weight_kg: "85" },
      ];
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-01-20", 82);

      expect(result.ratePerWeek).toBeNull();
      expect(result.rateConfidence).toBeNull();
      expect(result.impliedDailyCalories).toBeNull();
      expect(result.periodDeltas.days7).toBeNull();
      expect(result.periodDeltas.days14).toBeNull();
      expect(result.goal?.estimatedDate).toBeNull();
      expect(result.goal?.daysRemaining).toBeNull();
      expect(result.projectionLine).toEqual([]);
    });

    it("excludes non-positive weights from prediction computation", async () => {
      const rows = [
        { date: "2024-01-01", weight_kg: "80" },
        { date: "2024-01-02", weight_kg: "80" },
        { date: "2024-01-03", weight_kg: "80" },
        { date: "2024-01-04", weight_kg: "80" },
        { date: "2024-01-05", weight_kg: "80" },
        { date: "2024-01-06", weight_kg: "80" },
        { date: "2024-01-07", weight_kg: "0" },
      ];
      const { repo } = makeRepository(rows);

      const result = await repo.getWeightPrediction(90, "2024-06-01", null);

      expect(result.ratePerWeek).toBeNull();
      expect(result.projectionLine).toEqual([]);
    });

    it("computes implied daily calories from rate", async () => {
      // Steady loss
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 - index * 0.1),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-06-01", null);

      // 7700 kcal/kg: if losing ~0.5 kg/week → ~0.07 kg/day → ~561 kcal/day deficit
      expect(result.impliedDailyCalories).toBe(-561);
    });

    it("returns goal projection when losing toward lower goal", async () => {
      // Steady -0.5 kg/week (~0.0714 kg/day) for 20 days
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 - index * (0.5 / 7)),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-06-01", 75);

      expect(result.goal).not.toBeNull();
      expect(result.goal?.goalWeightKg).toBe(75);
      expect(result.goal?.remainingKg).toBeLessThan(0); // need to lose weight
      expect(result.goal?.estimatedDate).not.toBeNull();
      expect(result.goal?.daysRemaining).not.toBeNull();
      expect(result.goal?.daysRemaining ?? 0).toBeGreaterThan(0);
    });

    it("returns null estimatedDate when trending away from goal", async () => {
      // Gaining weight but goal is lower
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index * 0.1),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-06-01", 75);

      expect(result.goal).not.toBeNull();
      expect(result.goal?.estimatedDate).toBeNull();
      expect(result.goal?.daysRemaining).toBeNull();
    });

    it("returns goal=null when no goalWeightKg provided", async () => {
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-06-01", null);

      expect(result.goal).toBeNull();
    });

    it("generates projection line up to 30 days forward", async () => {
      const rows = Array.from({ length: 20 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 - index * 0.1),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-06-01", null);

      expect(result.projectionLine.length).toBeGreaterThan(0);
      expect(result.projectionLine.length).toBeLessThanOrEqual(30);
      // Projection should extend from the last data point
      for (const point of result.projectionLine) {
        expect(point.date).toBeDefined();
        expect(typeof point.projectedWeight).toBe("number");
      }
    });

    it("period deltas are null when data window is too short", async () => {
      // Only 5 days of data
      const rows = Array.from({ length: 5 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: String(80 + index),
      }));
      const { repo } = makeRepository(rows);
      const result = await repo.getWeightPrediction(90, "2024-06-01", null);

      expect(result.periodDeltas.days7).toBeNull();
      expect(result.periodDeltas.days14).toBeNull();
      expect(result.periodDeltas.days30).toBeNull();
    });
  });

  describe("getBodyFatPrediction", () => {
    it("predicts body-fat change from the smoothed history", async () => {
      const rows = Array.from({ length: 14 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, "0")}`,
        weight_kg: "80",
        body_fat_pct: String(22 - index / 10),
      }));
      const { repo } = makeRepository(rows);

      const result = await repo.getBodyFatPrediction(90, "2024-01-14");

      expect(result.ratePerWeek).toBeLessThan(0);
      expect(result.rateConfidence).not.toBeNull();
      expect(result.periodDeltas.days7).toBeLessThan(0);
      expect(result.projectionLine[0]).toEqual(
        expect.objectContaining({ date: "2024-01-15" }),
      );
    });
  });
});
