import { describe, expect, it } from "vitest";
import { detectUnitSystem, UnitConverter } from "./units.ts";

describe("UnitConverter re-export", () => {
  it("converts weight", () => {
    const metric = new UnitConverter("metric");
    const imperial = new UnitConverter("imperial");
    expect(metric.convertWeight(80)).toBeCloseTo(80);
    expect(imperial.convertWeight(80)).toBeCloseTo(176.37, 1);
  });

  it("converts distance", () => {
    const metric = new UnitConverter("metric");
    const imperial = new UnitConverter("imperial");
    expect(metric.convertDistance(10)).toBeCloseTo(10);
    expect(imperial.convertDistance(10)).toBeCloseTo(6.214, 2);
  });

  it("converts elevation", () => {
    const metric = new UnitConverter("metric");
    const imperial = new UnitConverter("imperial");
    expect(metric.convertElevation(1000)).toBeCloseTo(1000);
    expect(imperial.convertElevation(1000)).toBeCloseTo(3280.84, 0);
  });

  it("converts height", () => {
    const metric = new UnitConverter("metric");
    const imperial = new UnitConverter("imperial");
    expect(metric.convertHeight(170)).toBeCloseTo(170);
    expect(imperial.convertHeight(170)).toBeCloseTo(66.93, 1);
  });

  it("converts speed", () => {
    const metric = new UnitConverter("metric");
    const imperial = new UnitConverter("imperial");
    expect(metric.convertSpeed(100)).toBeCloseTo(100);
    expect(imperial.convertSpeed(100)).toBeCloseTo(62.14, 1);
  });

  it("converts temperature", () => {
    const metric = new UnitConverter("metric");
    const imperial = new UnitConverter("imperial");
    expect(metric.convertTemperature(37)).toBeCloseTo(37);
    expect(imperial.convertTemperature(37)).toBeCloseTo(98.6, 1);
  });

  it("returns correct labels", () => {
    const metric = new UnitConverter("metric");
    const imperial = new UnitConverter("imperial");
    expect(metric.weightLabel).toBe("kg");
    expect(imperial.weightLabel).toBe("lbs");
    expect(imperial.distanceLabel).toBe("mi");
  });
});

describe("detectUnitSystem re-export", () => {
  it("returns imperial for en-US", () => {
    expect(detectUnitSystem("en-US")).toBe("imperial");
  });

  it("returns metric for en-GB", () => {
    expect(detectUnitSystem("en-GB")).toBe("metric");
  });
});
