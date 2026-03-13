import { describe, expect, it } from "vitest";
import { fitCriticalHeartRate } from "../duration-curves.ts";

describe("fitCriticalHeartRate", () => {
  it("returns null with fewer than 3 points", () => {
    expect(
      fitCriticalHeartRate([
        { durationSeconds: 300, bestHeartRate: 180 },
        { durationSeconds: 600, bestHeartRate: 175 },
      ]),
    ).toBeNull();
  });

  it("fits a model from valid HR curve data", () => {
    // Simulated HR curve: HR decreases with longer durations
    // At short durations you can sustain higher HR, longer durations trend toward threshold
    const points = [
      { durationSeconds: 120, bestHeartRate: 190 },
      { durationSeconds: 300, bestHeartRate: 185 },
      { durationSeconds: 600, bestHeartRate: 180 },
      { durationSeconds: 1200, bestHeartRate: 175 },
      { durationSeconds: 1800, bestHeartRate: 172 },
      { durationSeconds: 3600, bestHeartRate: 168 },
    ];

    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
    // Threshold HR should be in a physiologically reasonable range
    expect(model?.thresholdHr).toBeGreaterThan(150);
    expect(model?.thresholdHr).toBeLessThan(195);
    expect(model?.r2).toBeGreaterThan(0);
  });

  it("treats flat HR as threshold HR with perfect fit", () => {
    // Constant HR across durations — model fits perfectly with thresholdHr = 170
    const points = [
      { durationSeconds: 120, bestHeartRate: 170 },
      { durationSeconds: 300, bestHeartRate: 170 },
      { durationSeconds: 600, bestHeartRate: 170 },
      { durationSeconds: 1200, bestHeartRate: 170 },
    ];

    const model = fitCriticalHeartRate(points);
    expect(model).not.toBeNull();
    expect(model?.thresholdHr).toBe(170);
    expect(model?.r2).toBe(1);
  });
});
