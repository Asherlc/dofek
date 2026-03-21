import { describe, expect, it } from "vitest";
import {
  convertDistance,
  convertElevation,
  convertHeight,
  convertPace,
  convertSpeed,
  convertTemperature,
  scaleTemperatureStddev,
  convertWeight,
  detectUnitSystem,
  distanceLabel,
  elevationLabel,
  formatDistance,
  formatElevation,
  formatHeight,
  formatSpeed,
  formatTemperature,
  formatWeight,
  heightLabel,
  paceLabel,
  speedLabel,
  temperatureLabel,
  weightLabel,
} from "./units.ts";

describe("unit conversions", () => {
  describe("weight (kg input)", () => {
    it("returns kg unchanged for metric", () => {
      expect(convertWeight(80, "metric")).toBeCloseTo(80);
    });

    it("converts kg to lbs for imperial", () => {
      expect(convertWeight(80, "imperial")).toBeCloseTo(176.37, 1);
    });

    it("handles zero", () => {
      expect(convertWeight(0, "imperial")).toBe(0);
    });
  });

  describe("distance (km input)", () => {
    it("returns km unchanged for metric", () => {
      expect(convertDistance(10, "metric")).toBeCloseTo(10);
    });

    it("converts km to miles for imperial", () => {
      expect(convertDistance(10, "imperial")).toBeCloseTo(6.214, 2);
    });
  });

  describe("elevation (meters input)", () => {
    it("returns meters unchanged for metric", () => {
      expect(convertElevation(1000, "metric")).toBeCloseTo(1000);
    });

    it("converts meters to feet for imperial", () => {
      expect(convertElevation(1000, "imperial")).toBeCloseTo(3280.84, 0);
    });
  });

  describe("temperature (celsius input)", () => {
    it("returns celsius unchanged for metric", () => {
      expect(convertTemperature(37, "metric")).toBeCloseTo(37);
    });

    it("converts celsius to fahrenheit for imperial", () => {
      expect(convertTemperature(0, "imperial")).toBeCloseTo(32);
      expect(convertTemperature(100, "imperial")).toBeCloseTo(212);
      expect(convertTemperature(37, "imperial")).toBeCloseTo(98.6, 1);
    });
  });

  describe("temperature stddev scaling", () => {
    it("returns stddev unchanged for metric", () => {
      expect(scaleTemperatureStddev(0.5, "metric")).toBeCloseTo(0.5);
    });

    it("scales stddev by 9/5 for imperial", () => {
      expect(scaleTemperatureStddev(0.5, "imperial")).toBeCloseTo(0.9);
      expect(scaleTemperatureStddev(1, "imperial")).toBeCloseTo(1.8);
    });
  });

  describe("speed (km/h input)", () => {
    it("returns km/h unchanged for metric", () => {
      expect(convertSpeed(100, "metric")).toBeCloseTo(100);
    });

    it("converts km/h to mph for imperial", () => {
      expect(convertSpeed(100, "imperial")).toBeCloseTo(62.14, 1);
    });
  });

  describe("height (cm input)", () => {
    it("returns cm unchanged for metric", () => {
      expect(convertHeight(170, "metric")).toBeCloseTo(170);
    });

    it("converts cm to inches for imperial", () => {
      expect(convertHeight(170, "imperial")).toBeCloseTo(66.93, 1);
    });
  });

  describe("pace (seconds/km input)", () => {
    it("returns seconds/km unchanged for metric", () => {
      expect(convertPace(300, "metric")).toBeCloseTo(300);
    });

    it("converts seconds/km to seconds/mi for imperial", () => {
      // 5:00/km = 8:03/mi (300s/km * 1.60934 = 482.8s/mi)
      expect(convertPace(300, "imperial")).toBeCloseTo(482.8, 0);
    });
  });
});

describe("unit labels", () => {
  it("returns metric labels", () => {
    expect(weightLabel("metric")).toBe("kg");
    expect(distanceLabel("metric")).toBe("km");
    expect(elevationLabel("metric")).toBe("m");
    expect(temperatureLabel("metric")).toBe("°C");
    expect(speedLabel("metric")).toBe("km/h");
    expect(heightLabel("metric")).toBe("cm");
    expect(paceLabel("metric")).toBe("/km");
  });

  it("returns imperial labels", () => {
    expect(weightLabel("imperial")).toBe("lbs");
    expect(distanceLabel("imperial")).toBe("mi");
    expect(elevationLabel("imperial")).toBe("ft");
    expect(temperatureLabel("imperial")).toBe("°F");
    expect(speedLabel("imperial")).toBe("mph");
    expect(heightLabel("imperial")).toBe("in");
    expect(paceLabel("imperial")).toBe("/mi");
  });
});

describe("format functions", () => {
  it("formats weight with appropriate precision", () => {
    expect(formatWeight(80.5, "metric")).toBe("80.5 kg");
    expect(formatWeight(80.5, "imperial")).toBe("177.5 lbs");
  });

  it("formats distance with 1 decimal", () => {
    expect(formatDistance(10.123, "metric")).toBe("10.1 km");
    expect(formatDistance(10.123, "imperial")).toBe("6.3 mi");
  });

  it("formats elevation with no decimals", () => {
    expect(formatElevation(1000, "metric")).toBe("1000 m");
    expect(formatElevation(1000, "imperial")).toBe("3281 ft");
  });

  it("formats temperature with 1 decimal", () => {
    expect(formatTemperature(37, "metric")).toBe("37.0 °C");
    expect(formatTemperature(37, "imperial")).toBe("98.6 °F");
  });

  it("formats speed with 1 decimal", () => {
    expect(formatSpeed(5.5, "metric")).toBe("5.5 km/h");
    expect(formatSpeed(5.5, "imperial")).toBe("3.4 mph");
  });

  it("formats height with 1 decimal", () => {
    expect(formatHeight(170, "metric")).toBe("170.0 cm");
    expect(formatHeight(170, "imperial")).toBe("66.9 in");
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
