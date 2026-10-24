import { formatDateTime } from "@dofek/format/format";
import { describe, expect, it } from "vitest";
import {
  BRAND_COLORS,
  formatProviderAbsentTombstoneSummary,
  formatProviderPartialAbsenceSummary,
  PROVIDER_LABELS,
  providerAbsentExplanation,
  providerLabel,
  providerLogoId,
  providerLogoType,
  providerRecordLabel,
  providerSourceLabel,
  providerSourceLogo,
} from "./providers.ts";

describe("PROVIDER_LABELS", () => {
  it("maps known provider IDs to readable labels", () => {
    expect(PROVIDER_LABELS.strava).toBe("Strava");
    expect(PROVIDER_LABELS.whoop).toBe("WHOOP (Cloud)");
    expect(PROVIDER_LABELS.whoop_ble).toBe("WHOOP (Bluetooth)");
    expect(PROVIDER_LABELS.ble_heart_rate).toBe("Heart Rate Monitor (Bluetooth)");
    expect(PROVIDER_LABELS["ride-with-gps"]).toBe("Ride with GPS");
    expect(PROVIDER_LABELS["cronometer-csv"]).toBe("Cronometer");
    expect(PROVIDER_LABELS["fit-file"]).toBe("FIT File");
    expect(PROVIDER_LABELS.fatsecret).toBe("fatsecret");
    expect(PROVIDER_LABELS.ziva).toBe("Ziva");
    expect(PROVIDER_LABELS.apple_health).toBe("Apple Health");
    expect(PROVIDER_LABELS.manual_review).toBe("Manual review");
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
    expect(providerLabel("ziva")).toBe("Ziva");
  });

  it("falls back to the raw ID for unknown providers", () => {
    expect(providerLabel("unknown-provider")).toBe("unknown-provider");
  });
});

describe("providerSourceLabel", () => {
  it("includes the Garmin recording model without repeating a provider-only name", () => {
    expect(providerSourceLabel("garmin", "Forerunner 965")).toBe("Garmin · Forerunner 965");
    expect(providerSourceLabel("garmin", "  fēnix 8 – 47mm  ")).toBe("Garmin · fēnix 8 – 47mm");
    expect(providerSourceLabel("garmin", "Garmin")).toBe("Garmin");
    expect(providerSourceLabel("garmin", null)).toBe("Garmin");
  });

  it("shows Apple Health upstream app names when present", () => {
    expect(providerSourceLabel("apple_health", "Strong")).toBe("Strong (via Apple Health)");
  });

  it("falls back to the provider label in other cases", () => {
    expect(providerSourceLabel("apple_health", null)).toBe("Apple Health");
    expect(providerSourceLabel("whoop", "Strong")).toBe("WHOOP (Cloud)");
  });
});

describe("providerRecordLabel", () => {
  it("combines the canonical provider and device labels without duplicating them", () => {
    expect(providerRecordLabel("whoop", "WHOOP 4.0")).toBe("WHOOP (Cloud) · WHOOP 4.0");
    expect(providerRecordLabel("whoop", "WHOOP")).toBe("WHOOP (Cloud)");
    expect(providerRecordLabel("whoop", "whoop (cloud)")).toBe("WHOOP (Cloud)");
    expect(providerRecordLabel("whoop", "  WHOOP 4.0  ")).toBe("WHOOP (Cloud) · WHOOP 4.0");
    expect(providerRecordLabel("whoop", "   ")).toBe("WHOOP (Cloud)");
    expect(providerRecordLabel("apple_health", null)).toBe("Apple Health");
  });
});

describe("providerAbsent summaries", () => {
  it("formats tombstone summaries in the viewer's local timezone", () => {
    const removedAt = "2026-06-22T21:30:00.000Z";
    expect(formatProviderAbsentTombstoneSummary("apple_health", removedAt)).toBe(
      `Removed from Apple Health · ${formatDateTime(removedAt)}`,
    );
  });

  it("formats partial absence summaries with provider labels", () => {
    const removedAt = "2026-03-05T14:30:00.000Z";
    expect(
      formatProviderPartialAbsenceSummary([{ providerId: "strava", providerAbsentAt: removedAt }]),
    ).toBe(`Strava removed · ${formatDateTime(removedAt)}`);
  });

  it("returns null for empty partial absence summaries", () => {
    expect(formatProviderPartialAbsenceSummary([])).toBeNull();
  });
});

describe("providerAbsentExplanation", () => {
  it("clarifies Apple Health subsource tombstones do not delete the upstream app activity", () => {
    expect(providerAbsentExplanation("apple_health", "Strava")).toContain("Apple Health copy");
    expect(providerAbsentExplanation("apple_health", "Strava")).toContain(
      "does not mean Strava deleted",
    );
  });

  it("uses the provider label for other providers", () => {
    expect(providerAbsentExplanation("strava", null)).toContain("Strava");
  });

  it("does not use the Apple Health duplicate explanation without a subsource", () => {
    expect(providerAbsentExplanation("apple_health", null)).not.toContain("Apple Health copy");
    expect(providerAbsentExplanation("apple_health", "")).not.toContain("Apple Health copy");
  });

  it("does not use the Apple Health duplicate explanation for non-Apple Health providers", () => {
    expect(providerAbsentExplanation("strava", "Garmin")).not.toContain("Apple Health copy");
  });
});

describe("BRAND_COLORS", () => {
  it("maps providers to hex color strings", () => {
    expect(BRAND_COLORS.dofek).toBe("#4A9D8E");
    expect(BRAND_COLORS.ble_heart_rate).toBe("#E0245E");
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
    expect(providerLogoType("whoop_ble")).toBe("png");
  });

  it("returns null for providers without logos", () => {
    expect(providerLogoType("ble_heart_rate")).toBeNull();
    expect(providerLogoType("unknown")).toBeNull();
    expect(providerLogoType("ziva")).toBeNull();
  });
});

describe("Ziva catalog metadata", () => {
  it("uses the generic provider presentation without guessed branding", () => {
    expect(BRAND_COLORS.ziva).toBeUndefined();
    expect(providerLogoType("ziva")).toBeNull();
  });
});

describe("providerLogoId", () => {
  it("resolves WHOOP Bluetooth to the shared WHOOP logo asset stem", () => {
    expect(providerLogoId("whoop_ble")).toBe("whoop");
    expect(providerLogoId("whoop")).toBe("whoop");
  });
});

describe("providerSourceLogo", () => {
  it.each([
    ["Strong", "strong-csv"],
    ["Hang Ten", "hang-ten"],
    ["Hang Ten Training", "hang-ten"],
    ["  wahoo  ", "wahoo"],
    ["New App", "New App"],
  ])("resolves Apple Health source %s", (source, provider) => {
    expect(providerSourceLogo("apple_health", source)).toEqual({ provider, viaAppleHealth: true });
  });
  it.each([null, "", "  ", "Apple Health", "HealthKit"])("keeps Apple Health for %s", (source) => {
    expect(providerSourceLogo("apple_health", source)).toEqual({
      provider: "apple_health",
      viaAppleHealth: false,
    });
  });
  it("supports the Apple Health alias", () => {
    expect(providerSourceLogo("apple-health", "Strong")).toEqual({
      provider: "strong-csv",
      viaAppleHealth: true,
    });
  });
  it("keeps direct provider identity", () => {
    expect(providerSourceLogo("wahoo", "Strong")).toEqual({
      provider: "wahoo",
      viaAppleHealth: false,
    });
  });
});
