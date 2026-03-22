import { describe, expect, it, vi } from "vitest";
import { UnitConverter } from "@dofek/format/units";

const mockSettings = { data: undefined as { value: unknown } | undefined };

vi.mock("./trpc", () => ({
  trpc: {
    settings: {
      get: { useQuery: () => mockSettings },
    },
  },
}));

const { useUnitConverter } = await import("./units");

describe("useUnitConverter", () => {
  it("returns metric converter when no setting exists", () => {
    mockSettings.data = undefined;
    const converter = useUnitConverter();
    expect(converter).toBeInstanceOf(UnitConverter);
    expect(converter.system).toBe("metric");
  });

  it("returns metric converter when setting value is 'metric'", () => {
    mockSettings.data = { value: "metric" };
    const converter = useUnitConverter();
    expect(converter.system).toBe("metric");
  });

  it("returns imperial converter when setting value is 'imperial'", () => {
    mockSettings.data = { value: "imperial" };
    const converter = useUnitConverter();
    expect(converter.system).toBe("imperial");
  });

  it("falls back to metric for unexpected values", () => {
    mockSettings.data = { value: "unknown-system" };
    const converter = useUnitConverter();
    expect(converter.system).toBe("metric");
  });

  it("falls back to metric when value is null", () => {
    mockSettings.data = { value: null };
    const converter = useUnitConverter();
    expect(converter.system).toBe("metric");
  });
});

describe("re-exported UnitConverter", () => {
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

  it("returns correct labels", () => {
    const metric = new UnitConverter("metric");
    const imperial = new UnitConverter("imperial");
    expect(metric.weightLabel).toBe("kg");
    expect(imperial.weightLabel).toBe("lbs");
    expect(imperial.distanceLabel).toBe("mi");
  });
});
