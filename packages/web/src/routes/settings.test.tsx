import { beforeAll, describe, expect, it, vi } from "vitest";

const captured: {
  validateSearch:
    | ((search: Record<string, unknown>) => {
        tab?: "general" | "health" | "connections" | "account";
        zeppPair?: string;
      })
    | null;
} = { validateSearch: null };

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: {
      validateSearch?: (search: Record<string, unknown>) => {
        tab?: "general" | "health" | "connections" | "account";
        zeppPair?: string;
      };
    }) => {
      captured.validateSearch = options.validateSearch ?? null;
      return options;
    },
}));

vi.mock("../pages/SettingsPage.tsx", () => ({
  SettingsPage: () => null,
  isSettingsTab: (value: unknown) =>
    value === "general" || value === "health" || value === "connections" || value === "account",
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

  it("drops invalid or empty settings search values", () => {
    expect(captured.validateSearch?.({ tab: "unknown", zeppPair: "" })).toEqual({});
  });
});
