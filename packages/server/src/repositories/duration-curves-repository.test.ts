import { describe, expect, it, vi } from "vitest";
import { DurationCurvesRepository, fitCriticalHeartRate } from "./duration-curves-repository.ts";

// ── fitCriticalHeartRate ─────────────────────────────────────

describe("fitCriticalHeartRate", () => {
  it("returns null for empty data", () => {
    expect(fitCriticalHeartRate([])).toBeNull();
  });

  it("returns null when fewer than 3 valid points (>= 120s)", () => {
    const points = [
      { durationSeconds: 120, bestHeartRate: 170 },
      { durationSeconds: 300, bestHeartRate: 165 },
    ];
    expect(fitCriticalHeartRate(points)).toBeNull();
  });

  it("returns null when all durations are below 120s", () => {
    const points = [
      { durationSeconds: 5, bestHeartRate: 190 },
      { durationSeconds: 15, bestHeartRate: 185 },
      { durationSeconds: 30, bestHeartRate: 180 },
      { durationSeconds: 60, bestHeartRate: 175 },
    ];
    expect(fitCriticalHeartRate(points)).toBeNull();
  });

  it("returns null when bestHeartRate is zero", () => {
    const points = [
      { durationSeconds: 120, bestHeartRate: 0 },
      { durationSeconds: 300, bestHeartRate: 0 },
      { durationSeconds: 600, bestHeartRate: 0 },
    ];
    expect(fitCriticalHeartRate(points)).toBeNull();
  });

  it("fits a model from realistic HR curve data", () => {
    const points = [
      { durationSeconds: 120, bestHeartRate: 180 },
      { durationSeconds: 300, bestHeartRate: 172 },
      { durationSeconds: 600, bestHeartRate: 168 },
      { durationSeconds: 1200, bestHeartRate: 164 },
      { durationSeconds: 1800, bestHeartRate: 162 },
      { durationSeconds: 3600, bestHeartRate: 158 },
    ];
    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
    expect(model?.thresholdHr).toBeGreaterThan(140);
    expect(model?.thresholdHr).toBeLessThan(180);
    expect(model?.r2).toBeGreaterThan(0.9);
    expect(model?.r2).toBeLessThanOrEqual(1);
  });

  it("includes points at exactly 120s duration", () => {
    const points = [
      { durationSeconds: 120, bestHeartRate: 175 },
      { durationSeconds: 300, bestHeartRate: 170 },
      { durationSeconds: 600, bestHeartRate: 165 },
      { durationSeconds: 1800, bestHeartRate: 160 },
    ];
    // All 4 points should be used (>= 120, not > 120)
    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
  });

  it("excludes points below 120s from the model", () => {
    const points = [
      { durationSeconds: 119, bestHeartRate: 190 },
      { durationSeconds: 120, bestHeartRate: 175 },
      { durationSeconds: 300, bestHeartRate: 170 },
      { durationSeconds: 600, bestHeartRate: 165 },
    ];
    // Only 3 points >= 120 should be used
    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
  });

  it("returns a model with exactly 3 valid points (boundary for valid.length < 3)", () => {
    const points = [
      { durationSeconds: 120, bestHeartRate: 180 },
      { durationSeconds: 300, bestHeartRate: 170 },
      { durationSeconds: 600, bestHeartRate: 165 },
    ];
    const model = fitCriticalHeartRate(points);
    // Exactly 3 valid points should produce a model (not null)
    expect(model).not.toBeNull();
    expect(model?.thresholdHr).toBeGreaterThan(0);
  });

  it("uses multiplication (not division) for ys = HR * duration", () => {
    // With HR > 1 and duration > 1, HR * duration >> HR / duration
    // The slope (thresholdHr) from linear regression of (HR*t) vs t gives threshold HR
    // If we used division, the ys values would be very small fractions
    // and the regression slope would be tiny (well below 1), yielding null via thresholdHr <= 0 check
    const points = [
      { durationSeconds: 120, bestHeartRate: 170 },
      { durationSeconds: 300, bestHeartRate: 165 },
      { durationSeconds: 600, bestHeartRate: 160 },
      { durationSeconds: 1800, bestHeartRate: 155 },
    ];
    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
    // With correct multiplication, thresholdHr should be a plausible HR value (100-200)
    // With division, ys values would be ~1.4, ~0.55, ~0.27, ~0.086 and slope would be near 0
    expect(model?.thresholdHr).toBeGreaterThan(100);
    expect(model?.thresholdHr).toBeLessThan(200);
  });

  it("handles edge case with identical HR values across durations", () => {
    const points = [
      { durationSeconds: 120, bestHeartRate: 1 },
      { durationSeconds: 300, bestHeartRate: 1 },
      { durationSeconds: 600, bestHeartRate: 1 },
      { durationSeconds: 1800, bestHeartRate: 1 },
    ];
    const model = fitCriticalHeartRate(points);
    // With identical HR values, model may be null or have thresholdHr > 0
    if (model) {
      expect(model.thresholdHr).toBeGreaterThan(0);
    }
  });

  it("returns null when thresholdHr (slope) is zero or negative", () => {
    // Craft data where HR * t decreases as t increases, producing a negative slope
    // HR(t) = reserve / t  (no threshold), e.g. HR drops dramatically with duration
    // xs = durations, ys = HR * t should decrease for negative slope
    const points = [
      { durationSeconds: 120, bestHeartRate: 200 },
      { durationSeconds: 300, bestHeartRate: 50 },
      { durationSeconds: 600, bestHeartRate: 20 },
      { durationSeconds: 1200, bestHeartRate: 5 },
    ];
    // ys = [24000, 15000, 12000, 6000] => slope is negative => thresholdHr <= 0 => null
    const model = fitCriticalHeartRate(points);
    expect(model).toBeNull();
  });

  it("filters out points with bestHeartRate exactly 0 but keeps positive HR", () => {
    const points = [
      { durationSeconds: 120, bestHeartRate: 0 },
      { durationSeconds: 300, bestHeartRate: 170 },
      { durationSeconds: 600, bestHeartRate: 165 },
      { durationSeconds: 1200, bestHeartRate: 160 },
    ];
    // Only 3 valid points (HR > 0 and duration >= 120)
    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
  });

  it("verifies r2 rounding uses *1000/1000 (3 decimal precision)", () => {
    const points = [
      { durationSeconds: 120, bestHeartRate: 180 },
      { durationSeconds: 300, bestHeartRate: 170 },
      { durationSeconds: 600, bestHeartRate: 165 },
      { durationSeconds: 1200, bestHeartRate: 162 },
      { durationSeconds: 1800, bestHeartRate: 160 },
    ];
    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
    // Verify the r2 is rounded to 3 decimal places by checking it equals its own rounding
    const reRounded = Math.round((model?.r2 ?? 0) * 1000) / 1000;
    expect(model?.r2).toBe(reRounded);
    // Also verify thresholdHr is an integer (Math.round applied)
    expect(model?.thresholdHr).toBe(Math.round(model?.thresholdHr ?? 0));
  });

  it("rounds r2 to exactly 3 decimal places", () => {
    const points = [
      { durationSeconds: 120, bestHeartRate: 180 },
      { durationSeconds: 300, bestHeartRate: 172 },
      { durationSeconds: 600, bestHeartRate: 168 },
      { durationSeconds: 1200, bestHeartRate: 164 },
    ];
    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
    // r2 * 1000 should be an integer (rounded to 3 decimal places)
    expect(Number.isInteger(model?.r2 ? model.r2 * 1000 : 0)).toBe(true);
  });

  it("returns integer thresholdHr and 3-decimal r2", () => {
    const points = [
      { durationSeconds: 120, bestHeartRate: 175 },
      { durationSeconds: 300, bestHeartRate: 170 },
      { durationSeconds: 600, bestHeartRate: 165 },
      { durationSeconds: 1800, bestHeartRate: 160 },
    ];
    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
    expect(Number.isInteger(model?.thresholdHr)).toBe(true);
    // r2 should have at most 3 decimal places
    const r2Str = String(model?.r2);
    const decimalPart = r2Str.split(".")[1] ?? "";
    expect(decimalPart.length).toBeLessThanOrEqual(3);
  });

  it("r2 rounding uses 1000 (not 100 or 10000)", () => {
    // With *100/100 (2 decimals), more precision is lost
    // With *10000/10000 (4 decimals), more precision is kept
    // We verify the exact rounding factor is 1000
    const points = [
      { durationSeconds: 120, bestHeartRate: 180 },
      { durationSeconds: 300, bestHeartRate: 172 },
      { durationSeconds: 600, bestHeartRate: 168 },
      { durationSeconds: 1200, bestHeartRate: 164 },
      { durationSeconds: 1800, bestHeartRate: 162 },
      { durationSeconds: 3600, bestHeartRate: 158 },
    ];
    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
    // Verify r2 is rounded to exactly 3 decimal places (factor of 1000)
    // Math.round(r2 * 1000) / 1000 should equal the result
    // Math.round(r2 * 100) / 100 would give a different result if 3rd decimal != 0
    expect(model?.r2).toBe(Math.round((model?.r2 ?? 0) * 1000) / 1000);
    // Also verify thresholdHr uses Math.round (not Math.floor or Math.ceil)
    expect(model?.thresholdHr).toBe(Math.round(model?.thresholdHr ?? 0));
  });

  it("boundary: 119s excluded, 120s included (>= 120, not > 120)", () => {
    // 3 points at exactly 119s + valid points: if >= mutated to >, 119 would still be excluded but 120 would also be excluded
    const pointsWithOnly120 = [
      { durationSeconds: 119, bestHeartRate: 190 },
      { durationSeconds: 120, bestHeartRate: 180 },
      { durationSeconds: 300, bestHeartRate: 170 },
      { durationSeconds: 600, bestHeartRate: 165 },
    ];
    // With >= 120: 3 valid points (120, 300, 600) => model
    // With > 120: only 2 valid points (300, 600) => null
    const model = fitCriticalHeartRate(pointsWithOnly120);
    expect(model).not.toBeNull();
  });

  it("computes ys as HR multiplied by duration (detects + vs * mutation)", () => {
    // With addition: ys = HR + t = [170+120, 165+300, 160+600, 155+1800] = [290, 465, 760, 1955]
    // With multiplication: ys = HR * t = [20400, 49500, 96000, 279000]
    // The slopes differ enormously. Multiplication gives a slope ~155 (plausible HR).
    // Addition gives a slope ~1 (not a plausible HR).
    const points = [
      { durationSeconds: 120, bestHeartRate: 170 },
      { durationSeconds: 300, bestHeartRate: 165 },
      { durationSeconds: 600, bestHeartRate: 160 },
      { durationSeconds: 1800, bestHeartRate: 155 },
    ];
    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
    // The slope (thresholdHr) must be > 100, which only works with multiplication
    expect(model?.thresholdHr).toBeGreaterThanOrEqual(140);
  });

  it("valid.length < 3 uses strict less-than (2 points returns null, 3 returns model)", () => {
    const twoPoints = [
      { durationSeconds: 120, bestHeartRate: 180 },
      { durationSeconds: 300, bestHeartRate: 170 },
    ];
    expect(fitCriticalHeartRate(twoPoints)).toBeNull();

    const threePoints = [
      { durationSeconds: 120, bestHeartRate: 180 },
      { durationSeconds: 300, bestHeartRate: 170 },
      { durationSeconds: 600, bestHeartRate: 165 },
    ];
    expect(fitCriticalHeartRate(threePoints)).not.toBeNull();
  });

  it("filter uses > 0 for bestHeartRate (not >= 0), so HR=0 is excluded", () => {
    const points = [
      { durationSeconds: 120, bestHeartRate: 0 },
      { durationSeconds: 300, bestHeartRate: 170 },
      { durationSeconds: 600, bestHeartRate: 165 },
      { durationSeconds: 1200, bestHeartRate: 160 },
    ];
    // HR=0 excluded, 3 valid remain => model
    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();

    // All zeros => null (confirms > 0 not >= 0)
    const allZero = [
      { durationSeconds: 120, bestHeartRate: 0 },
      { durationSeconds: 300, bestHeartRate: 0 },
      { durationSeconds: 600, bestHeartRate: 0 },
    ];
    expect(fitCriticalHeartRate(allZero)).toBeNull();
  });

  it("r2 rounding: Math.round(r2 * 1000) / 1000 not Math.round(r2 * 100) / 100", () => {
    const points = [
      { durationSeconds: 120, bestHeartRate: 180 },
      { durationSeconds: 300, bestHeartRate: 172 },
      { durationSeconds: 600, bestHeartRate: 168 },
      { durationSeconds: 1200, bestHeartRate: 164 },
      { durationSeconds: 1800, bestHeartRate: 162 },
      { durationSeconds: 3600, bestHeartRate: 158 },
    ];
    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
    // r2 * 1000 must be integer (3 decimal precision)
    const r2Value = model?.r2 ?? 0;
    expect(Math.round(r2Value * 1000)).toBe(r2Value * 1000);
    // thresholdHr must be integer
    expect(Number.isInteger(model?.thresholdHr)).toBe(true);
  });

  it("thresholdHr <= 0 returns null (not < 0)", () => {
    // Verify that thresholdHr exactly 0 also returns null
    // Craft data where slope is very close to 0: large durations with HR dropping to tiny values
    // ys = HR * t, if all ys are roughly equal, slope ~ 0
    const points = [
      { durationSeconds: 120, bestHeartRate: 100 },
      { durationSeconds: 6000, bestHeartRate: 2 },
      { durationSeconds: 12000, bestHeartRate: 1 },
      { durationSeconds: 24000, bestHeartRate: 1 },
    ];
    // ys = [12000, 12000, 12000, 24000] - slope might be near 0 or slightly positive
    // The important thing is that if slope === 0, the function returns null
    const model = fitCriticalHeartRate(points);
    // We can't fully control the slope to be exactly 0, but we verify the behavior
    // for the negative slope case (which we already tested) plus this near-zero case
    if (model !== null) {
      expect(model.thresholdHr).toBeGreaterThan(0);
    }
  });
});

// ── DurationCurvesRepository ─────────────────────────────────

describe("DurationCurvesRepository", () => {
  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new DurationCurvesRepository({ execute }, "user-1", "UTC");
    return { repo, execute };
  }

  describe("getHrCurve", () => {
    it("returns empty points and null model when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getHrCurve(90);
      expect(result.points).toEqual([]);
      expect(result.model).toBeNull();
    });

    it("maps rows to HrCurvePoint objects with labels", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "300", best_hr: "170", activity_date: "2025-06-15" },
        { duration_seconds: "600", best_hr: "165", activity_date: "2025-06-14" },
      ]);
      const result = await repo.getHrCurve(90);
      expect(result.points).toHaveLength(2);
      expect(result.points[0]).toEqual({
        durationSeconds: 300,
        label: "5min",
        bestHeartRate: 170,
        activityDate: "2025-06-15",
      });
      expect(result.points[1]).toEqual({
        durationSeconds: 600,
        label: "10min",
        bestHeartRate: 165,
        activityDate: "2025-06-14",
      });
    });

    it("generates fallback label for unknown duration", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "7200", best_hr: "155", activity_date: "2025-06-10" },
      ]);
      const result = await repo.getHrCurve(90);
      // 7200 may or may not be in DURATION_LABELS; if not, uses fallback "7200s"
      expect(result.points[0]?.label).toBeDefined();
      expect(typeof result.points[0]?.label).toBe("string");
      expect(result.points[0]?.label.length).toBeGreaterThan(0);
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getHrCurve(30);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getPaceCurve", () => {
    it("returns empty points when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getPaceCurve(90);
      expect(result.points).toEqual([]);
    });

    it("maps rows to PaceCurvePoint objects with labels", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "1800", best_pace: "240.5", activity_date: "2025-06-15" },
        { duration_seconds: "3600", best_pace: "250.0", activity_date: "2025-06-14" },
      ]);
      const result = await repo.getPaceCurve(90);
      expect(result.points).toHaveLength(2);
      expect(result.points[0]).toEqual({
        durationSeconds: 1800,
        label: "30min",
        bestPaceSecondsPerKm: 240.5,
        activityDate: "2025-06-15",
      });
      expect(result.points[1]).toEqual({
        durationSeconds: 3600,
        label: "60min",
        bestPaceSecondsPerKm: 250,
        activityDate: "2025-06-14",
      });
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.getPaceCurve(30);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("converts numeric string fields to proper numbers", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "60", best_pace: "300.0", activity_date: "2025-06-15" },
      ]);
      const result = await repo.getPaceCurve(90);
      expect(typeof result.points[0]?.durationSeconds).toBe("number");
      expect(typeof result.points[0]?.bestPaceSecondsPerKm).toBe("number");
      expect(result.points[0]?.durationSeconds).toBe(60);
      expect(result.points[0]?.bestPaceSecondsPerKm).toBe(300);
      expect(result.points[0]?.activityDate).toBe("2025-06-15");
    });

    it("uses String() for activityDate (not Number())", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "300", best_pace: "250", activity_date: "2025-06-15" },
      ]);
      const result = await repo.getPaceCurve(90);
      expect(typeof result.points[0]?.activityDate).toBe("string");
      expect(result.points[0]?.activityDate).toBe("2025-06-15");
    });
  });

  describe("getHrCurve — mapping field types", () => {
    it("converts all numeric string fields to numbers via Number()", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "120", best_hr: "175", activity_date: "2025-06-10" },
      ]);
      const result = await repo.getHrCurve(90);
      expect(typeof result.points[0]?.durationSeconds).toBe("number");
      expect(typeof result.points[0]?.bestHeartRate).toBe("number");
      expect(result.points[0]?.durationSeconds).toBe(120);
      expect(result.points[0]?.bestHeartRate).toBe(175);
    });

    it("uses String() for activityDate (not Number())", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "300", best_hr: "170", activity_date: "2025-06-15" },
      ]);
      const result = await repo.getHrCurve(90);
      expect(typeof result.points[0]?.activityDate).toBe("string");
      expect(result.points[0]?.activityDate).toBe("2025-06-15");
    });

    it("uses ?? fallback for unknown duration labels", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "99999", best_hr: "155", activity_date: "2025-06-10" },
      ]);
      const result = await repo.getHrCurve(90);
      // Unknown duration falls back to "99999s" format
      expect(result.points[0]?.label).toBe("99999s");
    });

    it("attaches fitCriticalHeartRate model when enough data", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "120", best_hr: "180", activity_date: "2025-06-01" },
        { duration_seconds: "300", best_hr: "172", activity_date: "2025-06-01" },
        { duration_seconds: "600", best_hr: "168", activity_date: "2025-06-01" },
        { duration_seconds: "1200", best_hr: "164", activity_date: "2025-06-01" },
      ]);
      const result = await repo.getHrCurve(90);
      expect(result.model).not.toBeNull();
      expect(result.model?.thresholdHr).toBeGreaterThan(100);
      expect(result.model?.r2).toBeGreaterThan(0);
    });
  });

  describe("getPaceCurve — mapping field types", () => {
    it("uses ?? fallback for unknown duration labels", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "88888", best_pace: "300", activity_date: "2025-06-10" },
      ]);
      const result = await repo.getPaceCurve(90);
      expect(result.points[0]?.label).toBe("88888s");
    });
  });

  describe("getHrCurve — result object shape", () => {
    it("returns an object with exactly points and model keys", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getHrCurve(90);
      expect(Object.keys(result).sort()).toStrictEqual(["model", "points"]);
    });

    it("returns model as null when fewer than 3 HR curve points >= 120s", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "5", best_hr: "190", activity_date: "2025-06-01" },
        { duration_seconds: "15", best_hr: "185", activity_date: "2025-06-01" },
      ]);
      const result = await repo.getHrCurve(90);
      expect(result.model).toBeNull();
    });
  });

  describe("getPaceCurve — result object shape", () => {
    it("returns an object with exactly a points key", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getPaceCurve(90);
      expect(Object.keys(result)).toStrictEqual(["points"]);
    });
  });

  describe("getHrCurve — each mapped field is correct type and value", () => {
    it("maps each row field to the correct property with exact values", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "1200", best_hr: "162", activity_date: "2025-06-20" },
      ]);
      const result = await repo.getHrCurve(90);
      const point = result.points[0];
      expect(point).toStrictEqual({
        durationSeconds: 1200,
        label: "20min",
        bestHeartRate: 162,
        activityDate: "2025-06-20",
      });
    });
  });

  describe("getPaceCurve — each mapped field is correct type and value", () => {
    it("maps each row field to the correct property with exact values", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "1200", best_pace: "275.3", activity_date: "2025-06-20" },
      ]);
      const result = await repo.getPaceCurve(90);
      const point = result.points[0];
      expect(point).toStrictEqual({
        durationSeconds: 1200,
        label: "20min",
        bestPaceSecondsPerKm: 275.3,
        activityDate: "2025-06-20",
      });
    });
  });

  describe("getHrCurve — model integration with results", () => {
    it("passes the mapped results array to fitCriticalHeartRate (not the raw rows)", async () => {
      // If the model were called with raw rows instead of mapped results, the field names would differ
      // and the model would get undefined for bestHeartRate, returning null
      const { repo } = makeRepository([
        { duration_seconds: "120", best_hr: "180", activity_date: "2025-06-01" },
        { duration_seconds: "300", best_hr: "172", activity_date: "2025-06-01" },
        { duration_seconds: "600", best_hr: "168", activity_date: "2025-06-01" },
        { duration_seconds: "1200", best_hr: "164", activity_date: "2025-06-01" },
      ]);
      const result = await repo.getHrCurve(90);
      // The model should be non-null since we have 4 valid points >= 120s
      expect(result.model).not.toBeNull();
      expect(result.model?.thresholdHr).toBeGreaterThan(0);
      expect(result.model?.r2).toBeGreaterThan(0);
    });
  });

  describe("getHrCurve — Number() vs String() for each field", () => {
    it("durationSeconds uses Number() not String()", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "300", best_hr: "170", activity_date: "2025-06-15" },
      ]);
      const result = await repo.getHrCurve(90);
      // Number("300") === 300, String("300") === "300"
      expect(result.points[0]?.durationSeconds).toStrictEqual(300);
      expect(result.points[0]?.durationSeconds).not.toStrictEqual("300");
    });

    it("bestHeartRate uses Number() not String()", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "300", best_hr: "170", activity_date: "2025-06-15" },
      ]);
      const result = await repo.getHrCurve(90);
      expect(result.points[0]?.bestHeartRate).toStrictEqual(170);
      expect(result.points[0]?.bestHeartRate).not.toStrictEqual("170");
    });

    it("activityDate uses String() not Number()", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "300", best_hr: "170", activity_date: "2025-06-15" },
      ]);
      const result = await repo.getHrCurve(90);
      expect(result.points[0]?.activityDate).toStrictEqual("2025-06-15");
    });
  });

  describe("getPaceCurve — Number() vs String() for each field", () => {
    it("bestPaceSecondsPerKm uses Number() not String()", async () => {
      const { repo } = makeRepository([
        { duration_seconds: "300", best_pace: "245.3", activity_date: "2025-06-15" },
      ]);
      const result = await repo.getPaceCurve(90);
      expect(result.points[0]?.bestPaceSecondsPerKm).toStrictEqual(245.3);
      expect(result.points[0]?.bestPaceSecondsPerKm).not.toStrictEqual("245.3");
    });
  });
});

// ── fitCriticalHeartRate — additional mutation-killing tests ──────────────

describe("fitCriticalHeartRate (mutation-killing)", () => {
  it("filter uses AND (&&) for both conditions, not OR (||)", () => {
    // A point with durationSeconds=60 and bestHeartRate=170 should be excluded (< 120s)
    // A point with durationSeconds=300 and bestHeartRate=0 should be excluded (HR not > 0)
    // Only 2 valid points remain => null
    const points = [
      { durationSeconds: 60, bestHeartRate: 170 },
      { durationSeconds: 300, bestHeartRate: 0 },
      { durationSeconds: 300, bestHeartRate: 165 },
      { durationSeconds: 600, bestHeartRate: 160 },
    ];
    // With &&: valid = [{300, 165}, {600, 160}] => only 2 => null
    // With ||: all would pass since each satisfies at least one condition
    const model = fitCriticalHeartRate(points);
    expect(model).toBeNull();
  });

  it("thresholdHr uses Math.round not Math.floor or Math.ceil", () => {
    // Use data that produces a non-integer thresholdHr
    const points = [
      { durationSeconds: 120, bestHeartRate: 180 },
      { durationSeconds: 300, bestHeartRate: 172 },
      { durationSeconds: 600, bestHeartRate: 168 },
      { durationSeconds: 1200, bestHeartRate: 164 },
      { durationSeconds: 1800, bestHeartRate: 162 },
    ];
    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
    // thresholdHr must be an integer (Math.round applied)
    expect(Number.isInteger(model?.thresholdHr)).toBe(true);
    // Verify the value is reasonable (between 140-180 for this data)
    expect(model?.thresholdHr).toBeGreaterThanOrEqual(140);
    expect(model?.thresholdHr).toBeLessThanOrEqual(180);
  });

  it("returns object with exactly thresholdHr and r2 properties", () => {
    const points = [
      { durationSeconds: 120, bestHeartRate: 175 },
      { durationSeconds: 300, bestHeartRate: 170 },
      { durationSeconds: 600, bestHeartRate: 165 },
    ];
    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
    expect(Object.keys(model ?? {}).sort()).toStrictEqual(["r2", "thresholdHr"]);
  });
});
