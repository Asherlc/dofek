import { describe, expect, it } from "vitest";
import {
  heartRateZoneCountColumns,
  heartRateZoneSqlParams,
  heartRateZoneSumColumns,
  heartRateZoneWeightedCountColumns,
} from "./heart-rate-zone-sql.ts";

describe("heart-rate-zone-sql", () => {
  it("emits query parameters for every canonical zone boundary", () => {
    expect(heartRateZoneSqlParams()).toEqual({
      heartRateZone0MinPctHrr: 0,
      heartRateZone0MaxPctHrr: 0.5,
      heartRateZone1MinPctHrr: 0.5,
      heartRateZone1MaxPctHrr: 0.6,
      heartRateZone2MinPctHrr: 0.6,
      heartRateZone2MaxPctHrr: 0.7,
      heartRateZone3MinPctHrr: 0.7,
      heartRateZone3MaxPctHrr: 0.8,
      heartRateZone4MinPctHrr: 0.8,
      heartRateZone4MaxPctHrr: 0.9,
      heartRateZone5MinPctHrr: 0.9,
      heartRateZone5MaxPctHrr: 1,
    });
  });

  it("generates count columns with activity metadata heart-rate expressions", () => {
    expect(
      heartRateZoneCountColumns("heart_rate", { maxHr: "am.max_hr", restingHr: "am.resting_hr" }),
    ).toBe(
      [
        "countIf(heart_rate < am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone0MaxPctHrr:Float64}) AS zone0",
        "countIf(heart_rate >= am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone1MinPctHrr:Float64}\n                AND heart_rate < am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone1MaxPctHrr:Float64}) AS zone1",
        "countIf(heart_rate >= am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone2MinPctHrr:Float64}\n                AND heart_rate < am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone2MaxPctHrr:Float64}) AS zone2",
        "countIf(heart_rate >= am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone3MinPctHrr:Float64}\n                AND heart_rate < am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone3MaxPctHrr:Float64}) AS zone3",
        "countIf(heart_rate >= am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone4MinPctHrr:Float64}\n                AND heart_rate < am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone4MaxPctHrr:Float64}) AS zone4",
        "countIf(heart_rate >= am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone5MinPctHrr:Float64}) AS zone5",
      ].join(",\n          "),
    );
  });

  it("generates sum projections for zone zero through zone five", () => {
    expect(heartRateZoneSumColumns()).toBe(
      [
        "sum(zone0) AS zone0",
        "sum(zone1) AS zone1",
        "sum(zone2) AS zone2",
        "sum(zone3) AS zone3",
        "sum(zone4) AS zone4",
        "sum(zone5) AS zone5",
      ].join(",\n        "),
    );
  });

  it("weights histogram counts with the canonical inclusive lower and exclusive upper boundaries", () => {
    expect(
      heartRateZoneWeightedCountColumns("sample.1", "sample.2", {
        maxHr: "am.max_hr",
        restingHr: "am.resting_hr",
      }),
    ).toBe(
      [
        "sumIf(sample.2, sample.1 < am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone0MaxPctHrr:Float64}) AS zone0",
        "sumIf(sample.2, sample.1 >= am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone1MinPctHrr:Float64}\n                AND sample.1 < am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone1MaxPctHrr:Float64}) AS zone1",
        "sumIf(sample.2, sample.1 >= am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone2MinPctHrr:Float64}\n                AND sample.1 < am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone2MaxPctHrr:Float64}) AS zone2",
        "sumIf(sample.2, sample.1 >= am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone3MinPctHrr:Float64}\n                AND sample.1 < am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone3MaxPctHrr:Float64}) AS zone3",
        "sumIf(sample.2, sample.1 >= am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone4MinPctHrr:Float64}\n                AND sample.1 < am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone4MaxPctHrr:Float64}) AS zone4",
        "sumIf(sample.2, sample.1 >= am.resting_hr + (am.max_hr - am.resting_hr) * {heartRateZone5MinPctHrr:Float64}) AS zone5",
      ].join(",\n          "),
    );
  });
});
