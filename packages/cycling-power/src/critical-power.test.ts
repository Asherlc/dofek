import { describe, expect, it } from "vitest";
import { fitCriticalPower, fitCriticalPowerWithDiagnostics } from "./critical-power.ts";

const policy = { minimumDurationSeconds: 120, maximumDurationSeconds: 600 };

describe("fitCriticalPower", () => {
  it("withholds a fit when finite work values overflow regression sums", () => {
    expect(
      fitCriticalPower(
        [
          { durationSeconds: 120, bestPower: 1e304 },
          { durationSeconds: 300, bestPower: 1.1e304 },
          { durationSeconds: 600, bestPower: 1.2e304 },
        ],
        policy,
      ),
    ).toBeNull();
  });
  it("keeps finite observations usable when another observation is non-finite", () => {
    expect(
      fitCriticalPower(
        [
          { durationSeconds: 120, bestPower: 355 },
          { durationSeconds: 300, bestPower: 280 },
          { durationSeconds: 600, bestPower: 255 },
          { durationSeconds: 240, bestPower: Number.POSITIVE_INFINITY },
          { durationSeconds: Number.NaN, bestPower: 300 },
          { durationSeconds: 360, bestPower: Number.NaN },
        ],
        policy,
      ),
    ).toEqual({ cp: 230, wPrime: 15_000, r2: 1 });
  });

  it("withholds a model when fewer than three finite observations remain", () => {
    expect(
      fitCriticalPower(
        [
          { durationSeconds: 120, bestPower: Number.POSITIVE_INFINITY },
          { durationSeconds: 300, bestPower: 280 },
          { durationSeconds: 600, bestPower: 255 },
        ],
        policy,
      ),
    ).toBeNull();
  });

  it("withholds a fit when finite inputs overflow the regression arithmetic", () => {
    expect(
      fitCriticalPower(
        [
          { durationSeconds: 120, bestPower: Number.MAX_VALUE },
          { durationSeconds: 300, bestPower: Number.MAX_VALUE },
          { durationSeconds: 600, bestPower: Number.MAX_VALUE },
        ],
        policy,
      ),
    ).toBeNull();
  });

  it.each([
    { minimumDurationSeconds: 0, maximumDurationSeconds: 600 },
    { minimumDurationSeconds: Number.NaN, maximumDurationSeconds: 600 },
    { minimumDurationSeconds: 120, maximumDurationSeconds: Number.NaN },
    { minimumDurationSeconds: 120, maximumDurationSeconds: Number.POSITIVE_INFINITY },
    { minimumDurationSeconds: 600, maximumDurationSeconds: 120 },
  ])("rejects an invalid duration interval %j", (invalidPolicy) => {
    expect(() => fitCriticalPower([], invalidPolicy)).toThrow();
  });

  function powerCurve(
    cp: number,
    wPrime: number,
    durations: number[],
  ): { durationSeconds: number; bestPower: number }[] {
    return durations.map((t) => ({
      durationSeconds: t,
      bestPower: cp + wPrime / t,
    }));
  }

  it("recovers CP from ideal power curve data", () => {
    const points = powerCurve(230, 15000, [120, 300, 600]);
    const model = fitCriticalPower(points, policy);
    expect(model).not.toBeNull();
    expect(model?.cp).toBeCloseTo(230, 0);
    expect(model?.wPrime).toBeCloseTo(15000, -2);
    expect(model?.r2).toBeGreaterThan(0.99);
  });

  it("ignores long-duration data suppressed by interval training", () => {
    const shortDurations = powerCurve(230, 15000, [120, 300, 600]);
    const suppressedLongDurations = [
      { durationSeconds: 1200, bestPower: 200 },
      { durationSeconds: 1800, bestPower: 185 },
      { durationSeconds: 3600, bestPower: 170 },
    ];
    const model = fitCriticalPower([...shortDurations, ...suppressedLongDurations], policy);
    expect(model).not.toBeNull();
    expect(model?.cp).toBeCloseTo(230, 0);
  });

  it("returns null with fewer than 3 valid points", () => {
    const points = powerCurve(230, 15000, [120, 300]);
    expect(fitCriticalPower(points, policy)).toBeNull();
  });

  it("returns null when CP would be negative", () => {
    const points = [
      { durationSeconds: 120, bestPower: 300 },
      { durationSeconds: 300, bestPower: 200 },
      { durationSeconds: 600, bestPower: 50 },
    ];
    const model = fitCriticalPower(points, policy);
    expect(model).toBeNull();
  });

  it("returns null when CP would be exactly zero", () => {
    expect(fitCriticalPower(powerCurve(0, 15_000, [120, 300, 600]), policy)).toBeNull();
  });

  it("returns null when anaerobic work capacity would be non-positive", () => {
    expect(
      fitCriticalPower(
        [
          { durationSeconds: 120, bestPower: 200 },
          { durationSeconds: 300, bestPower: 250 },
          { durationSeconds: 600, bestPower: 280 },
        ],
        policy,
      ),
    ).toBeNull();
  });

  it("returns null when anaerobic work capacity would be exactly zero", () => {
    expect(fitCriticalPower(powerCurve(250, 0, [120, 300, 600]), policy)).toBeNull();
  });

  it("excludes durations under 120s", () => {
    const points = [
      { durationSeconds: 5, bestPower: 800 },
      { durationSeconds: 15, bestPower: 600 },
      { durationSeconds: 30, bestPower: 500 },
      { durationSeconds: 60, bestPower: 400 },
    ];
    expect(fitCriticalPower(points, policy)).toBeNull();
  });

  it("excludes durations over 600s from fitting", () => {
    const points = [
      { durationSeconds: 700, bestPower: 230 },
      { durationSeconds: 1200, bestPower: 220 },
      { durationSeconds: 1800, bestPower: 210 },
    ];
    expect(fitCriticalPower(points, policy)).toBeNull();
  });

  it("excludes points with zero power", () => {
    const points = [
      { durationSeconds: 120, bestPower: 0 },
      { durationSeconds: 300, bestPower: 0 },
      { durationSeconds: 600, bestPower: 0 },
    ];
    expect(fitCriticalPower(points, policy)).toBeNull();
  });

  it("includes boundary durations 120s and 600s", () => {
    const points = powerCurve(250, 20000, [120, 360, 600]);
    const model = fitCriticalPower(points, policy);
    expect(model).not.toBeNull();
    expect(model?.cp).toBeCloseTo(250, 0);
  });

  it("rounds cp, wPrime, and r2 values", () => {
    const points = powerCurve(230, 15000, [120, 180, 240, 300, 420, 600]);
    const model = fitCriticalPower(points, policy);
    expect(model).not.toBeNull();
    expect(Number.isInteger(model?.cp)).toBe(true);
    expect(Number.isInteger(model?.wPrime)).toBe(true);
    const r2Str = String(model?.r2);
    const decimals = r2Str.split(".")[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(3);
  });

  it("returns the fitted observations, predictions, residuals, and RMSE", () => {
    const points = [
      { durationSeconds: 120, bestPower: 360 },
      { durationSeconds: 300, bestPower: 285 },
      { durationSeconds: 600, bestPower: 258 },
    ];

    const model = fitCriticalPowerWithDiagnostics(points, policy);

    expect(model).toEqual({
      cp: 232,
      wPrime: 15_502,
      r2: 1,
      rmse: 1.1,
      points: [
        {
          durationSeconds: 120,
          observedPower: 360,
          predictedPower: 361.5,
          residualPower: -1.5,
        },
        {
          durationSeconds: 300,
          observedPower: 285,
          predictedPower: 284,
          residualPower: 1,
        },
        {
          durationSeconds: 600,
          observedPower: 258,
          predictedPower: 258.2,
          residualPower: -0.2,
        },
      ],
    });
  });

  it("rounds RMSE only after aggregating unrounded residuals", () => {
    const model = fitCriticalPowerWithDiagnostics(
      [
        { durationSeconds: 120, bestPower: 325 },
        { durationSeconds: 300, bestPower: 250.05 },
        { durationSeconds: 600, bestPower: 225 },
      ],
      policy,
    );
    // Raw residuals are approximately [-0.05102, 0.03265, -0.00612] W.
    // Their RMS is 0.03515 W: round once to 0.0 W, rather than 0.1 W
    // from prematurely rounding the individual residuals.
    expect(model?.rmse).toBe(0);
    expect(model?.points[0]?.residualPower).toBe(-0.1);
  });

  it("returns null for empty input", () => {
    expect(fitCriticalPower([], policy)).toBeNull();
  });
});
