import { describe, expect, it } from "vitest";
import { selectDailyHeartRateVariability } from "./heart-rate-variability.ts";

describe("selectDailyHeartRateVariability", () => {
  it("returns the average reading when multiple exist", () => {
    const result = selectDailyHeartRateVariability([
      { value: 45, startDate: new Date("2024-01-15T04:00:00Z") },
      { value: 50, startDate: new Date("2024-01-15T10:00:00Z") },
      { value: 121, startDate: new Date("2024-01-15T22:00:00Z") },
    ]);

    expect(result).toBe(72); // (45+50+121)/3 = 216/3 = 72
  });

  it("returns the single reading when only one exists", () => {
    const result = selectDailyHeartRateVariability([
      { value: 52, startDate: new Date("2024-01-15T06:00:00Z") },
    ]);

    expect(result).toBe(52);
  });

  it("returns null for an empty array", () => {
    const result = selectDailyHeartRateVariability([]);

    expect(result).toBeNull();
  });

  it("calculates average regardless of array order", () => {
    const result = selectDailyHeartRateVariability([
      { value: 121, startDate: new Date("2024-01-15T22:00:00Z") },
      { value: 45, startDate: new Date("2024-01-15T04:00:00Z") },
      { value: 50, startDate: new Date("2024-01-15T10:00:00Z") },
    ]);

    expect(result).toBe(72);
  });

  it("handles string dates (ISO 8601)", () => {
    const result = selectDailyHeartRateVariability([
      { value: 45, startDate: "2024-01-15T04:00:00Z" },
      { value: 105, startDate: "2024-01-15T22:00:00Z" },
    ]);

    expect(result).toBe(75); // (45+105)/2 = 75
  });
});
