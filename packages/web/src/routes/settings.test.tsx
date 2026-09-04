import { beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeSettingsCategory, type SettingsCategory } from "../pages/settingsCategories.ts";

const captured: {
  validateSearch:
    | ((search: Record<string, unknown>) => {
        tab?: SettingsCategory;
      })
    | null;
} = { validateSearch: null };

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: {
      validateSearch?: (search: Record<string, unknown>) => {
        tab?: SettingsCategory;
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
    ["general", "goals-models"],
    ["health", "goals-models"],
    ["account", "account"],
  ] as const)("normalizes the legacy %s tab to %s", (legacyTab, currentCategory) => {
    expect(normalizeSettingsCategory(legacyTab)).toBe(currentCategory);
    expect(captured.validateSearch?.({ tab: legacyTab })).toEqual({ tab: currentCategory });
  });

  it("keeps the Advanced tab deep-link value", () => {
    expect(normalizeSettingsCategory("advanced")).toBe("advanced");
    expect(captured.validateSearch?.({ tab: "advanced" })).toEqual({ tab: "advanced" });
  });

  it("drops invalid or empty settings search values", () => {
    expect(captured.validateSearch?.({ tab: "unknown" })).toEqual({});
    expect(captured.validateSearch?.({ tab: ["connections"] })).toEqual({});
  });
});
