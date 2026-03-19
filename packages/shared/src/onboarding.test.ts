import { describe, expect, it } from "vitest";
import {
  ONBOARDING_CATEGORIES,
  ONBOARDING_SETTINGS_KEY,
  shouldShowOnboarding,
} from "./onboarding.ts";

describe("shouldShowOnboarding", () => {
  it("returns true when no providers connected and not dismissed", () => {
    expect(shouldShowOnboarding(0, false)).toBe(true);
  });

  it("returns false when at least one provider connected", () => {
    expect(shouldShowOnboarding(1, false)).toBe(false);
  });

  it("returns false when dismissed", () => {
    expect(shouldShowOnboarding(0, true)).toBe(false);
  });

  it("returns false when both providers connected and dismissed", () => {
    expect(shouldShowOnboarding(3, true)).toBe(false);
  });
});

describe("ONBOARDING_CATEGORIES", () => {
  it("has at least one category", () => {
    expect(ONBOARDING_CATEGORIES.length).toBeGreaterThan(0);
  });

  it("each category has a non-empty title, description, and providerIds", () => {
    for (const category of ONBOARDING_CATEGORIES) {
      expect(category.title).toBeTruthy();
      expect(category.description).toBeTruthy();
      expect(category.providerIds.length).toBeGreaterThan(0);
    }
  });

  it("all provider IDs are non-empty strings", () => {
    for (const category of ONBOARDING_CATEGORIES) {
      for (const id of category.providerIds) {
        expect(typeof id).toBe("string");
        expect(id.length).toBeGreaterThan(0);
      }
    }
  });

  it("has no duplicate category titles", () => {
    const titles = ONBOARDING_CATEGORIES.map((c) => c.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("ONBOARDING_SETTINGS_KEY", () => {
  it("is a non-empty string", () => {
    expect(typeof ONBOARDING_SETTINGS_KEY).toBe("string");
    expect(ONBOARDING_SETTINGS_KEY.length).toBeGreaterThan(0);
  });
});
