import { describe, expect, it } from "vitest";
import { computeRecommendedBedtime, computeSleepPerformance } from "./sleep-performance.ts";

describe("computeSleepPerformance", () => {
  it("returns Peak tier for 90%+ performance", () => {
    const result = computeSleepPerformance(480, 480, 95);
    expect(result.tier).toBe("Peak");
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it("returns Perform tier for 70-89% performance", () => {
    const result = computeSleepPerformance(400, 480, 90);
    expect(result.tier).toBe("Perform");
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.score).toBeLessThan(90);
  });

  it("returns Get By tier for 50-69% performance", () => {
    const result = computeSleepPerformance(300, 480, 85);
    expect(result.tier).toBe("Get By");
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.score).toBeLessThan(70);
  });

  it("returns Low tier for <50% performance", () => {
    const result = computeSleepPerformance(180, 480, 70);
    expect(result.tier).toBe("Low");
    expect(result.score).toBeLessThan(50);
  });

  it("caps score at 100 when sleep exceeds need", () => {
    const result = computeSleepPerformance(600, 480, 98);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("weights sufficiency 70% and efficiency 30%", () => {
    // Full sufficiency (100%) with low efficiency
    const highSuffLowEff = computeSleepPerformance(480, 480, 60);
    // Low sufficiency with high efficiency
    const lowSuffHighEff = computeSleepPerformance(300, 480, 98);
    // The first should score higher because sufficiency has more weight
    expect(highSuffLowEff.score).toBeGreaterThan(lowSuffHighEff.score);
  });

  it("handles zero needed minutes", () => {
    const result = computeSleepPerformance(420, 0, 90);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.tier).toBeDefined();
  });
});

describe("computeRecommendedBedtime", () => {
  it("subtracts sleep need from wake time", () => {
    // Wake at 7:00, need 8h (480m), 15m to fall asleep = bed at 22:45
    const result = computeRecommendedBedtime("07:00", 480, 15);
    expect(result).toBe("22:45");
  });

  it("defaults to 15 minutes fall-asleep time", () => {
    const result = computeRecommendedBedtime("07:00", 480);
    expect(result).toBe("22:45");
  });

  it("handles wrapping past midnight", () => {
    // Wake at 6:00, need 9h (540m), 15m to fall asleep = bed at 20:45
    const result = computeRecommendedBedtime("06:00", 540, 15);
    expect(result).toBe("20:45");
  });

  it("handles very early wake times", () => {
    // Wake at 5:00, need 8h = bed at 20:45
    const result = computeRecommendedBedtime("05:00", 480, 15);
    expect(result).toBe("20:45");
  });
});
