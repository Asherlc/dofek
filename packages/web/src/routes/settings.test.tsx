import { beforeAll, describe, expect, it, vi } from "vitest";

const captured: {
  validateSearch:
    | ((search: Record<string, unknown>) => {
        tab?:
          | "account"
          | "data-sources"
          | "goals-models"
          | "privacy-export"
          | "notifications"
          | "billing"
          | "advanced";
        zeppPair?: string;
      })
    | null;
} = { validateSearch: null };

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: {
      validateSearch?: (search: Record<string, unknown>) => {
        tab?:
          | "account"
          | "data-sources"
          | "goals-models"
          | "privacy-export"
          | "notifications"
          | "billing"
          | "advanced";
        zeppPair?: string;
      };
    }) => {
      captured.validateSearch = options.validateSearch ?? null;
      return options;
    },
}));

vi.mock("../pages/SettingsPage.tsx", () => ({
  SettingsPage: () => null,
  normalizeSettingsCategory: (value: unknown) => {
    if (
      value === "account" ||
      value === "data-sources" ||
      value === "goals-models" ||
      value === "privacy-export" ||
      value === "notifications" ||
      value === "billing" ||
      value === "advanced"
    ) {
      return value;
    }
    if (value === "connections") return "data-sources";
    if (value === "general" || value === "health") return "goals-models";
    return undefined;
  },
}));

beforeAll(async () => {
  await import("./settings.tsx");
});

describe("settings search validation", () => {
  it("keeps valid tab and Zepp pairing deep-link values", () => {
    expect(captured.validateSearch?.({ tab: "data-sources", zeppPair: "ABC234" })).toEqual({
      tab: "data-sources",
      zeppPair: "ABC234",
    });
  });

  it.each([
    ["connections", "data-sources"],
    ["general", "goals-models"],
    ["health", "goals-models"],
    ["account", "account"],
  ] as const)("normalizes the legacy %s tab to %s", (legacyTab, currentCategory) => {
    expect(captured.validateSearch?.({ tab: legacyTab })).toEqual({ tab: currentCategory });
  });

  it("drops invalid or empty settings search values", () => {
    expect(captured.validateSearch?.({ tab: "unknown", zeppPair: "" })).toEqual({});
  });
});
