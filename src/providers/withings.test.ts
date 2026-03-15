import { describe, expect, it } from "vitest";
import { parseMeasureGroup, type WithingsMeasureGroup } from "./withings.ts";

// ============================================================
// Pure parsing unit tests
// ============================================================

// Withings returns values as (value * 10^unit), e.g. weight 72.5kg = value:72500, unit:-3

const scaleGroup: WithingsMeasureGroup = {
  grpid: 1001,
  date: 1709251200, // Unix seconds
  category: 1, // real measurement
  measures: [
    { type: 1, value: 72500, unit: -3 }, // weight 72.5 kg
    { type: 6, value: 215, unit: -1 }, // fat ratio 21.5%
    { type: 76, value: 31200, unit: -3 }, // muscle mass 31.2 kg
    { type: 88, value: 3100, unit: -3 }, // bone mass 3.1 kg
    { type: 77, value: 38500, unit: -3 }, // hydration 38.5 kg (water)
    { type: 5, value: 57300, unit: -3 }, // fat free mass 57.3 kg
    { type: 8, value: 15200, unit: -3 }, // fat mass weight 15.2 kg
  ],
};

const bpGroup: WithingsMeasureGroup = {
  grpid: 2001,
  date: 1709337600,
  category: 1,
  measures: [
    { type: 10, value: 120, unit: 0 }, // systolic 120 mmHg
    { type: 9, value: 80, unit: 0 }, // diastolic 80 mmHg
    { type: 11, value: 72, unit: 0 }, // heart pulse 72 bpm
  ],
};

const tempGroup: WithingsMeasureGroup = {
  grpid: 3001,
  date: 1709424000,
  category: 1,
  measures: [
    { type: 71, value: 3720, unit: -2 }, // body temp 37.20 C
  ],
};

describe("Withings Provider — parsing", () => {
  describe("parseMeasureGroup", () => {
    it("parses scale measurements", () => {
      const result = parseMeasureGroup(scaleGroup);
      expect(result.externalId).toBe("1001");
      expect(result.recordedAt).toEqual(new Date(1709251200 * 1000));
      expect(result.weightKg).toBeCloseTo(72.5);
      expect(result.bodyFatPct).toBeCloseTo(21.5);
      expect(result.muscleMassKg).toBeCloseTo(31.2);
      expect(result.boneMassKg).toBeCloseTo(3.1);
      expect(result.waterPct).toBeUndefined(); // hydration is in kg, not %
      expect(result.systolicBp).toBeUndefined();
    });

    it("parses blood pressure measurements", () => {
      const result = parseMeasureGroup(bpGroup);
      expect(result.systolicBp).toBe(120);
      expect(result.diastolicBp).toBe(80);
      expect(result.heartPulse).toBe(72);
      expect(result.weightKg).toBeUndefined();
    });

    it("parses temperature measurements", () => {
      const result = parseMeasureGroup(tempGroup);
      expect(result.temperatureC).toBeCloseTo(37.2);
      expect(result.weightKg).toBeUndefined();
    });

    it("skips user objectives (category 2)", () => {
      const objective = { ...scaleGroup, category: 2 };
      const result = parseMeasureGroup(objective);
      expect(result.weightKg).toBeUndefined();
    });

    it("computes BMI when weight is present", () => {
      // BMI needs height which comes from user profile, not from measure group
      // So parseMeasureGroup doesn't compute BMI itself
      const result = parseMeasureGroup(scaleGroup);
      expect(result.bmi).toBeUndefined();
    });
  });
});
