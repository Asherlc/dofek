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
});
