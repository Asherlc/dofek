import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  normalizeSettingsCategory,
  SETTINGS_CATEGORIES,
  type SettingsCategory,
} from "../pages/settingsCategories.ts";

const captured: {
  validateSearch:
    | ((search: Record<string, unknown>) => {
        tab?: SettingsCategory;
        section?: "cycling-ftp";
        date?: string;
      })
    | null;
} = { validateSearch: null };

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: {
      validateSearch?: (search: Record<string, unknown>) => {
        tab?: SettingsCategory;
        section?: "cycling-ftp";
        date?: string;
      };
    }) => {
      captured.validateSearch = options.validateSearch ?? null;
      return options;
    },
}));

vi.mock("../pages/SettingsPage.tsx", () => ({
  SettingsPage: () => null,
}));

beforeAll(async () => {
  await import("./settings.tsx");
});

describe("settings search validation", () => {
  it.each([
    ["connections", "data-sources"],
    ["general", "models-units"],
    ["health", "models-units"],
    ["account", "account"],
  ] as const)("normalizes the legacy %s tab to %s", (legacyTab, currentCategory) => {
    expect(normalizeSettingsCategory(legacyTab)).toBe(currentCategory);
    expect(captured.validateSearch?.({ tab: legacyTab })).toEqual({ tab: currentCategory });
  });

  it("keeps the Advanced tab deep-link value", () => {
    expect(normalizeSettingsCategory("advanced")).toBe("advanced");
    expect(captured.validateSearch?.({ tab: "advanced" })).toEqual({ tab: "advanced" });
  });

  it("keeps the FTP section and a valid local calendar date", () => {
    expect(
      captured.validateSearch?.({
        tab: "models-units",
        section: "cycling-ftp",
        date: "2026-11-03",
      }),
    ).toEqual({ tab: "models-units", section: "cycling-ftp", date: "2026-11-03" });
  });

  it("drops unknown FTP sections and impossible date targets", () => {
    expect(captured.validateSearch?.({ section: "cycling-history", date: "2026-11-03" })).toEqual({
      date: "2026-11-03",
    });
    expect(captured.validateSearch?.({ section: "cycling-ftp", date: "2026-02-30" })).toEqual({
      section: "cycling-ftp",
    });
  });

  it("makes developer integrations discoverable in Advanced settings search", () => {
    const advanced = SETTINGS_CATEGORIES.find((category) => category.id === "advanced");

    expect(advanced?.searchText).toContain("developer integrations");
    expect(advanced?.searchText).toContain("OAuth");
  });

  it("drops invalid or empty settings search values", () => {
    expect(captured.validateSearch?.({ tab: "unknown" })).toEqual({});
    expect(captured.validateSearch?.({ tab: ["connections"] })).toEqual({});
  });
});
