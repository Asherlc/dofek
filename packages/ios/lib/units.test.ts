import { describe, expect, it, vi } from "vitest";
import {
  convertDistance,
  convertWeight,
  distanceLabel,
  weightLabel,
} from "./units";

const mockSettings = { data: undefined as { value: unknown } | undefined };

vi.mock("./trpc", () => ({
  trpc: {
    settings: {
      get: { useQuery: () => mockSettings },
    },
  },
}));

const { useUnitSystem } = await import("./units");

describe("useUnitSystem", () => {
  it("returns 'metric' when no setting exists", () => {
    mockSettings.data = undefined;
    expect(useUnitSystem()).toBe("metric");
  });

  it("returns 'metric' when setting value is 'metric'", () => {
    mockSettings.data = { value: "metric" };
    expect(useUnitSystem()).toBe("metric");
  });

  it("returns 'imperial' when setting value is 'imperial'", () => {
    mockSettings.data = { value: "imperial" };
    expect(useUnitSystem()).toBe("imperial");
  });

  it("falls back to 'metric' for unexpected values", () => {
    mockSettings.data = { value: "unknown-system" };
    expect(useUnitSystem()).toBe("metric");
  });

  it("falls back to 'metric' when value is null", () => {
    mockSettings.data = { value: null };
    expect(useUnitSystem()).toBe("metric");
  });
});

describe("re-exported conversion functions", () => {
  it("converts weight", () => {
    expect(convertWeight(80, "metric")).toBeCloseTo(80);
    expect(convertWeight(80, "imperial")).toBeCloseTo(176.37, 1);
  });

  it("converts distance", () => {
    expect(convertDistance(10, "metric")).toBeCloseTo(10);
    expect(convertDistance(10, "imperial")).toBeCloseTo(6.214, 2);
  });

  it("returns correct labels", () => {
    expect(weightLabel("metric")).toBe("kg");
    expect(weightLabel("imperial")).toBe("lbs");
    expect(distanceLabel("imperial")).toBe("mi");
  });
});
