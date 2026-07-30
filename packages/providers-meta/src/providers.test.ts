import { formatDateTime } from "@dofek/format/format";
import { describe, expect, it } from "vitest";
import {
  BRAND_COLORS,
  formatProviderAbsentTombstoneSummary,
  formatProviderPartialAbsenceSummary,
  PNG_LOGOS,
  PROVIDER_LABELS,
  providerAbsentExplanation,
  providerLabel,
  providerLogoId,
  providerLogoType,
  providerRecordLabel,
  providerSourceLabel,
  resolveProviderProvenance,
  SVG_LOGOS,
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
  });

  it("falls back to the raw ID for unknown providers", () => {
    expect(providerLabel("unknown-provider")).toBe("unknown-provider");
  });
});

describe("resolveProviderProvenance", () => {
  it("pairs the canonical human label with the diagnostic provider ID", () => {
    expect(resolveProviderProvenance("manual_review")).toEqual({
      providerId: "manual_review",
      label: "Manual review",
    });
  });
});

describe("providerSourceLabel", () => {
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
    expect(providerLogoType("velohero")).toBeNull();
    expect(providerLogoType("ble_heart_rate")).toBeNull();
    expect(providerLogoType("unknown")).toBeNull();
  });
});

describe("providerLogoId", () => {
  it("resolves WHOOP Bluetooth to the shared WHOOP logo asset stem", () => {
    expect(providerLogoId("whoop_ble")).toBe("whoop");
    expect(providerLogoId("whoop")).toBe("whoop");
  });
});
