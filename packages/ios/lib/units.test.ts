import { describe, expect, it } from "vitest";
import {
  convertDistance,
  convertElevation,
  convertPace,
  convertSpeed,
  convertTemperature,
  convertWeight,
  distanceLabel,
  elevationLabel,
  paceLabel,
  speedLabel,
  temperatureLabel,
  weightLabel,
} from "./units";

describe("re-exported conversion functions", () => {
  it("converts weight", () => {
    expect(convertWeight(80, "metric")).toBeCloseTo(80);
    expect(convertWeight(80, "imperial")).toBeCloseTo(176.37, 1);
  });

  it("converts distance", () => {
    expect(convertDistance(10, "metric")).toBeCloseTo(10);
    expect(convertDistance(10, "imperial")).toBeCloseTo(6.214, 2);
  });

  it("converts elevation", () => {
    expect(convertElevation(1000, "imperial")).toBeCloseTo(3280.84, 0);
  });

  it("converts temperature", () => {
    expect(convertTemperature(37, "imperial")).toBeCloseTo(98.6, 1);
  });

  it("converts speed", () => {
    expect(convertSpeed(100, "imperial")).toBeCloseTo(62.14, 1);
  });

  it("converts pace", () => {
    expect(convertPace(300, "imperial")).toBeCloseTo(482.8, 0);
  });
});

describe("re-exported label functions", () => {
  it("returns correct labels", () => {
    expect(weightLabel("metric")).toBe("kg");
    expect(weightLabel("imperial")).toBe("lbs");
    expect(distanceLabel("imperial")).toBe("mi");
    expect(elevationLabel("imperial")).toBe("ft");
    expect(temperatureLabel("imperial")).toBe("°F");
    expect(speedLabel("imperial")).toBe("mph");
    expect(paceLabel("imperial")).toBe("/mi");
  });
});
