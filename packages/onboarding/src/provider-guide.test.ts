import { describe, expect, it } from "vitest";
import {
  PROVIDER_GUIDE_CATEGORIES,
  PROVIDER_GUIDE_SETTINGS_KEY,
  shouldShowProviderGuide,
} from "./provider-guide";

describe("shouldShowProviderGuide", () => {
  it("returns true when no providers connected and not dismissed", () => {
    expect(shouldShowProviderGuide(0, false)).toBe(true);
  });

  it("returns false when at least one provider connected", () => {
    expect(shouldShowProviderGuide(1, false)).toBe(false);
  });

  it("returns false when dismissed", () => {
    expect(shouldShowProviderGuide(0, true)).toBe(false);
  });

  it("returns false when both providers connected and dismissed", () => {
    expect(shouldShowProviderGuide(3, true)).toBe(false);
  });
});

describe("PROVIDER_GUIDE_CATEGORIES", () => {
  it("has at least one category", () => {
    expect(PROVIDER_GUIDE_CATEGORIES.length).toBeGreaterThan(0);
  });

  it("each category has a non-empty title, description, and providerIds", () => {
    for (const category of PROVIDER_GUIDE_CATEGORIES) {
      expect(category.title).toBeTruthy();
      expect(category.description).toBeTruthy();
      expect(category.providerIds.length).toBeGreaterThan(0);
    }
  });

  it("all provider IDs are non-empty strings", () => {
    for (const category of PROVIDER_GUIDE_CATEGORIES) {
      for (const providerId of category.providerIds) {
        expect(typeof providerId).toBe("string");
        expect(providerId.length).toBeGreaterThan(0);
      }
    }
  });

  it("categorizes the canonical Cycling Analytics provider ID", () => {
    const activityTracking = PROVIDER_GUIDE_CATEGORIES.find(
      (category) => category.title === "Activity Tracking",
    );
    expect(activityTracking?.providerIds).toContain("cycling_analytics");
    expect(activityTracking?.providerIds).not.toContain("cycling-analytics");
  });

  it("categorizes BodySpec as a body composition provider", () => {
    const bodyComposition = PROVIDER_GUIDE_CATEGORIES.find(
      (category) => category.title === "Body Composition",
    );
    expect(bodyComposition?.providerIds).toContain("bodyspec");
  });

  it("has no duplicate category titles", () => {
    const titles = PROVIDER_GUIDE_CATEGORIES.map((category) => category.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("PROVIDER_GUIDE_SETTINGS_KEY", () => {
  it("is a non-empty string", () => {
    expect(typeof PROVIDER_GUIDE_SETTINGS_KEY).toBe("string");
    expect(PROVIDER_GUIDE_SETTINGS_KEY.length).toBeGreaterThan(0);
  });
});
