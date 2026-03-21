import { describe, expect, it } from "vitest";
import { detectUnitSystem, UnitConverter } from "./units.ts";

describe("UnitConverter", () => {
  const metric = new UnitConverter("metric");
  const imperial = new UnitConverter("imperial");

  describe("weight (kg input)", () => {
    it("returns kg unchanged for metric", () => {
      expect(metric.convertWeight(80)).toBeCloseTo(80);
    });

    it("converts kg to lbs for imperial", () => {
      expect(imperial.convertWeight(80)).toBeCloseTo(176.37, 1);
    });

    it("handles zero", () => {
      expect(imperial.convertWeight(0)).toBe(0);
    });
  });

  describe("distance (km input)", () => {
    it("returns km unchanged for metric", () => {
      expect(metric.convertDistance(10)).toBeCloseTo(10);
    });

    it("converts km to miles for imperial", () => {
      expect(imperial.convertDistance(10)).toBeCloseTo(6.214, 2);
    });
  });

  describe("elevation (meters input)", () => {
    it("returns meters unchanged for metric", () => {
      expect(metric.convertElevation(1000)).toBeCloseTo(1000);
    });

    it("converts meters to feet for imperial", () => {
      expect(imperial.convertElevation(1000)).toBeCloseTo(3280.84, 0);
    });
  });

  describe("temperature (celsius input)", () => {
    it("returns celsius unchanged for metric", () => {
      expect(metric.convertTemperature(37)).toBeCloseTo(37);
    });

    it("converts celsius to fahrenheit for imperial", () => {
      expect(imperial.convertTemperature(0)).toBeCloseTo(32);
      expect(imperial.convertTemperature(100)).toBeCloseTo(212);
      expect(imperial.convertTemperature(37)).toBeCloseTo(98.6, 1);
    });
  });

  describe("temperature stddev scaling", () => {
    it("returns stddev unchanged for metric", () => {
      expect(metric.scaleTemperatureStddev(0.5)).toBeCloseTo(0.5);
    });

    it("scales stddev by 9/5 for imperial", () => {
      expect(imperial.scaleTemperatureStddev(0.5)).toBeCloseTo(0.9);
      expect(imperial.scaleTemperatureStddev(1)).toBeCloseTo(1.8);
    });
  });

  describe("speed (km/h input)", () => {
    it("returns km/h unchanged for metric", () => {
      expect(metric.convertSpeed(100)).toBeCloseTo(100);
    });

    it("converts km/h to mph for imperial", () => {
      expect(imperial.convertSpeed(100)).toBeCloseTo(62.14, 1);
    });
  });

  describe("height (cm input)", () => {
    it("returns cm unchanged for metric", () => {
      expect(metric.convertHeight(170)).toBeCloseTo(170);
    });

    it("converts cm to inches for imperial", () => {
      expect(imperial.convertHeight(170)).toBeCloseTo(66.93, 1);
    });
  });

  describe("pace (seconds/km input)", () => {
    it("returns seconds/km unchanged for metric", () => {
      expect(metric.convertPace(300)).toBeCloseTo(300);
    });

    it("converts seconds/km to seconds/mi for imperial", () => {
      // 5:00/km = 8:03/mi (300s/km * 1.60934 = 482.8s/mi)
      expect(imperial.convertPace(300)).toBeCloseTo(482.8, 0);
    });
  });
});

describe("unit labels", () => {
  const metric = new UnitConverter("metric");
  const imperial = new UnitConverter("imperial");

  it("returns metric labels", () => {
    expect(metric.weightLabel).toBe("kg");
    expect(metric.distanceLabel).toBe("km");
    expect(metric.elevationLabel).toBe("m");
    expect(metric.temperatureLabel).toBe("°C");
    expect(metric.speedLabel).toBe("km/h");
    expect(metric.heightLabel).toBe("cm");
    expect(metric.paceLabel).toBe("/km");
  });

  it("returns imperial labels", () => {
    expect(imperial.weightLabel).toBe("lbs");
    expect(imperial.distanceLabel).toBe("mi");
    expect(imperial.elevationLabel).toBe("ft");
    expect(imperial.temperatureLabel).toBe("°F");
    expect(imperial.speedLabel).toBe("mph");
    expect(imperial.heightLabel).toBe("in");
    expect(imperial.paceLabel).toBe("/mi");
  });
});

describe("format functions", () => {
  const metric = new UnitConverter("metric");
  const imperial = new UnitConverter("imperial");

  it("formats weight with appropriate precision", () => {
    expect(metric.formatWeight(80.5)).toBe("80.5 kg");
    expect(imperial.formatWeight(80.5)).toBe("177.5 lbs");
  });

  it("formats distance with 1 decimal", () => {
    expect(metric.formatDistance(10.123)).toBe("10.1 km");
    expect(imperial.formatDistance(10.123)).toBe("6.3 mi");
  });

  it("formats elevation with no decimals", () => {
    expect(metric.formatElevation(1000)).toBe("1000 m");
    expect(imperial.formatElevation(1000)).toBe("3281 ft");
  });

  it("formats temperature with 1 decimal", () => {
    expect(metric.formatTemperature(37)).toBe("37.0 °C");
    expect(imperial.formatTemperature(37)).toBe("98.6 °F");
  });

  it("formats speed with 1 decimal", () => {
    expect(metric.formatSpeed(5.5)).toBe("5.5 km/h");
    expect(imperial.formatSpeed(5.5)).toBe("3.4 mph");
  });

  it("formats height with 1 decimal", () => {
    expect(metric.formatHeight(170)).toBe("170.0 cm");
    expect(imperial.formatHeight(170)).toBe("66.9 in");
  });
});

describe("detectUnitSystem", () => {
  it("returns imperial for en-US", () => {
    expect(detectUnitSystem("en-US")).toBe("imperial");
  });

  it("returns metric for en-GB", () => {
    expect(detectUnitSystem("en-GB")).toBe("metric");
  });

  it("returns metric for de-DE", () => {
    expect(detectUnitSystem("de-DE")).toBe("metric");
  });

  it("returns metric for ja-JP", () => {
    expect(detectUnitSystem("ja-JP")).toBe("metric");
  });

  it("returns imperial for en-MM (Myanmar)", () => {
    expect(detectUnitSystem("en-MM")).toBe("imperial");
  });

  it("returns imperial for en-LR (Liberia)", () => {
    expect(detectUnitSystem("en-LR")).toBe("imperial");
  });

  it("returns metric for locale without country code", () => {
    expect(detectUnitSystem("en")).toBe("metric");
  });

  it("is case insensitive for country code", () => {
    expect(detectUnitSystem("en-us")).toBe("imperial");
  });
});
