import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SettingsTab } from "../pages/settingsTabs.ts";

const captured: {
  validateSearch:
    | ((search: Record<string, unknown>) => {
        tab?: SettingsTab;
        zeppPair?: string;
      })
    | null;
} = { validateSearch: null };

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: {
      validateSearch?: (search: Record<string, unknown>) => {
        tab?: SettingsTab;
        zeppPair?: string;
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
  it("keeps valid tab and Zepp pairing deep-link values", () => {
    expect(captured.validateSearch?.({ tab: "connections", zeppPair: "ABC234" })).toEqual({
      tab: "connections",
      zeppPair: "ABC234",
    });
  });

  it("keeps the Advanced tab deep-link value", () => {
    expect(captured.validateSearch?.({ tab: "advanced" })).toEqual({ tab: "advanced" });
  });

  it("drops invalid or empty settings search values", () => {
    expect(captured.validateSearch?.({ tab: "unknown", zeppPair: "" })).toEqual({});
  });
});
