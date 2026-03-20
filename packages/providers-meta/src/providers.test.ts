import { describe, expect, it } from "vitest";
import {
  BRAND_COLORS,
  PNG_LOGOS,
  PROVIDER_LABELS,
  providerLabel,
  providerLogoType,
  SVG_LOGOS,
} from "./providers.ts";

describe("PROVIDER_LABELS", () => {
  it("maps known provider IDs to readable labels", () => {
    expect(PROVIDER_LABELS.strava).toBe("Strava");
    expect(PROVIDER_LABELS.whoop).toBe("WHOOP");
    expect(PROVIDER_LABELS["ride-with-gps"]).toBe("Ride with GPS");
    expect(PROVIDER_LABELS["cronometer-csv"]).toBe("Cronometer");
    expect(PROVIDER_LABELS.apple_health).toBe("Apple Health");
  });

  it("all values are non-empty strings", () => {
    for (const [key, value] of Object.entries(PROVIDER_LABELS)) {
      expect(typeof key).toBe("string");
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

describe("providerLabel", () => {
  it("returns the label for a known provider ID", () => {
    expect(providerLabel("strava")).toBe("Strava");
    expect(providerLabel("eight-sleep")).toBe("Eight Sleep");
    expect(providerLabel("apple_health")).toBe("Apple Health");
  });

  it("falls back to the raw ID for unknown providers", () => {
    expect(providerLabel("unknown-provider")).toBe("unknown-provider");
  });
});

describe("SVG_LOGOS", () => {
  it("contains providers with SVG logos", () => {
    expect(SVG_LOGOS.has("strava")).toBe(true);
    expect(SVG_LOGOS.has("garmin")).toBe(true);
    expect(SVG_LOGOS.has("google")).toBe(true);
  });

  it("does not contain PNG-only providers", () => {
    expect(SVG_LOGOS.has("wahoo")).toBe(false);
    expect(SVG_LOGOS.has("whoop")).toBe(false);
  });
});

describe("PNG_LOGOS", () => {
  it("contains providers with PNG logos", () => {
    expect(PNG_LOGOS.has("wahoo")).toBe(true);
    expect(PNG_LOGOS.has("whoop")).toBe(true);
    expect(PNG_LOGOS.has("polar")).toBe(true);
  });

  it("does not contain SVG providers", () => {
    expect(PNG_LOGOS.has("strava")).toBe(false);
    expect(PNG_LOGOS.has("garmin")).toBe(false);
  });
});

describe("BRAND_COLORS", () => {
  it("maps providers to hex color strings", () => {
    expect(BRAND_COLORS.velohero).toBe("#FF6600");
    expect(BRAND_COLORS.bodyspec).toBe("#00B4D8");
  });
});

describe("providerLogoType", () => {
  it("returns 'svg' for SVG logo providers", () => {
    expect(providerLogoType("strava")).toBe("svg");
    expect(providerLogoType("garmin")).toBe("svg");
  });

  it("returns 'png' for PNG logo providers", () => {
    expect(providerLogoType("wahoo")).toBe("png");
    expect(providerLogoType("whoop")).toBe("png");
  });

  it("returns null for providers without logos", () => {
    expect(providerLogoType("velohero")).toBeNull();
    expect(providerLogoType("unknown")).toBeNull();
  });
});
