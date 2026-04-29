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

  it("accepts inclusive cycling power bounds when weight is valid", () => {
    expect(
      estimateCyclingVo2Max({
        fiveMinutePowerWatts: 50,
        weightKg: 75,
      }),
    ).toBeCloseTo(14.2);
    expect(
      estimateCyclingVo2Max({
        fiveMinutePowerWatts: 700,
        weightKg: 75,
      }),
    ).toBeCloseTo(107.8);
  });

  it("returns null when cycling power or weight is not finite", () => {
    expect(
      estimateCyclingVo2Max({
        fiveMinutePowerWatts: Number.NaN,
        weightKg: 75,
      }),
    ).toBeNull();
    expect(
      estimateCyclingVo2Max({
        fiveMinutePowerWatts: Number.POSITIVE_INFINITY,
        weightKg: 75,
      }),
    ).toBeNull();
    expect(
      estimateCyclingVo2Max({
        fiveMinutePowerWatts: 300,
        weightKg: Number.NaN,
      }),
    ).toBeNull();
    expect(
      estimateCyclingVo2Max({
        fiveMinutePowerWatts: 300,
        weightKg: Number.POSITIVE_INFINITY,
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

  it("accepts inclusive speed bounds when other ACSM inputs are valid", () => {
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 40,
        grade: 0,
        averageHeartRate: 140,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeCloseTo(12.19);
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 450,
        grade: 0,
        averageHeartRate: 140,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeCloseTo(151.94);
  });

  it("accepts inclusive grade bounds when other ACSM inputs are valid", () => {
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 100,
        grade: -0.15,
        averageHeartRate: 140,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeCloseTo(-21.94);
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 100,
        grade: 0.15,
        averageHeartRate: 140,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeCloseTo(65.81);
  });

  it("accepts intensity exactly 0.6 and rejects intensity exactly 1.0", () => {
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 100,
        grade: 0,
        averageHeartRate: 138,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeCloseTo(22.5);
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 100,
        grade: 0,
        averageHeartRate: 190,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeNull();
  });

  it("returns null when max heart rate is not greater than resting heart rate", () => {
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 100,
        grade: 0,
        averageHeartRate: 60,
        restingHeartRate: 60,
        maxHeartRate: 60,
      }),
    ).toBeNull();
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 100,
        grade: 0,
        averageHeartRate: 100,
        restingHeartRate: 190,
        maxHeartRate: 60,
      }),
    ).toBeNull();
  });

  it("returns null when ACSM speed, grade, or heart rate inputs are not finite", () => {
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: Number.NaN,
        grade: 0,
        averageHeartRate: 140,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeNull();
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 100,
        grade: Number.POSITIVE_INFINITY,
        averageHeartRate: 140,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeNull();
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 100,
        grade: 0,
        averageHeartRate: Number.NaN,
        restingHeartRate: 60,
        maxHeartRate: 190,
      }),
    ).toBeNull();
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 100,
        grade: 0,
        averageHeartRate: 140,
        restingHeartRate: Number.NEGATIVE_INFINITY,
        maxHeartRate: 190,
      }),
    ).toBeNull();
    expect(
      estimateSubmaximalAcsmVo2Max({
        speedMetersPerMinute: 100,
        grade: 0,
        averageHeartRate: 140,
        restingHeartRate: 60,
        maxHeartRate: Number.POSITIVE_INFINITY,
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
