import { describe, expect, it } from "vitest";
import {
  averageVo2MaxEstimates,
  estimateCyclingVo2Max,
  estimateSubmaximalAcsmVo2Max,
  isSupportedOutdoorVo2MaxActivityType,
} from "./derived-cardio.ts";

describe("estimateCyclingVo2Max", () => {
  it("estimates cycling VO2 max from five-minute power and weight", () => {
    expect(
      estimateCyclingVo2Max({
        fiveMinutePowerWatts: 300,
        weightKg: 75,
      }),
    ).toBeCloseTo(50.2);
  });

  it("returns null when power or weight is outside supported bounds", () => {
    expect(
      estimateCyclingVo2Max({
        fiveMinutePowerWatts: 49,
        weightKg: 75,
      }),
    ).toBeNull();
    expect(
      estimateCyclingVo2Max({
        fiveMinutePowerWatts: 701,
        weightKg: 75,
      }),
    ).toBeNull();
    expect(
      estimateCyclingVo2Max({
        fiveMinutePowerWatts: 300,
        weightKg: null,
      }),
    ).toBeNull();
  });
});

describe("estimateSubmaximalAcsmVo2Max", () => {
  it("estimates walking VO2 max using the ACSM walking equation below the running threshold", () => {
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 100,
        grade: 0,
        averageHeartRate: 140,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeCloseTo(21.94);
  });

  it("estimates running VO2 max using the ACSM running equation at or above the running threshold", () => {
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 200,
        grade: 0,
        averageHeartRate: 160,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeCloseTo(56.55);
  });

  it("returns null when speed, grade, or heart rate intensity is outside supported bounds", () => {
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 39,
        grade: 0,
        averageHeartRate: 140,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeNull();
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 100,
        grade: 0.16,
        averageHeartRate: 140,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeNull();
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 100,
        grade: 0,
        averageHeartRate: 137,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeNull();
  });
});

describe("averageVo2MaxEstimates", () => {
  it("averages non-null VO2 max estimates", () => {
    expect(averageVo2MaxEstimates([40, null, 50, 55])).toBeCloseTo(48.33);
  });

  it("returns null when all estimates are null", () => {
    expect(averageVo2MaxEstimates([null, null])).toBeNull();
  });
});

describe("isSupportedOutdoorVo2MaxActivityType", () => {
  it("returns true for supported outdoor activity types", () => {
    expect(isSupportedOutdoorVo2MaxActivityType("running")).toBe(true);
    expect(isSupportedOutdoorVo2MaxActivityType("trail_running")).toBe(true);
    expect(isSupportedOutdoorVo2MaxActivityType("walking")).toBe(true);
    expect(isSupportedOutdoorVo2MaxActivityType("hiking")).toBe(true);
  });

  it("returns false for unsupported activity types", () => {
    expect(isSupportedOutdoorVo2MaxActivityType("indoor_running")).toBe(false);
    expect(isSupportedOutdoorVo2MaxActivityType("strength")).toBe(false);
  });
});
