import { describe, expect, it } from "vitest";
import { PROVIDER_LABELS, providerLabel } from "./providers.ts";

describe("PROVIDER_LABELS", () => {
  it("maps known provider IDs to readable labels", () => {
    expect(PROVIDER_LABELS.strava).toBe("Strava");
    expect(PROVIDER_LABELS.whoop).toBe("WHOOP");
    expect(PROVIDER_LABELS["ride-with-gps"]).toBe("Ride with GPS");
    expect(PROVIDER_LABELS["cronometer-csv"]).toBe("Cronometer");
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
  });

  it("falls back to the raw ID for unknown providers", () => {
    expect(providerLabel("unknown-provider")).toBe("unknown-provider");
  });
});
