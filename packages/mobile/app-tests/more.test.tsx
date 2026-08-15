/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

vi.mock("@expo/vector-icons", () => ({
  Ionicons: () => null,
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("../theme", () => ({
  colors: {
    accent: "#16a34a",
    background: "#ffffff",
    border: "#d4d4d8",
    surface: "#fafafa",
    text: "#18181b",
    textSecondary: "#52525b",
  },
  radius: { lg: 12 },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
}));

describe("MoreScreen", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it.each([
    [
      "Account & settings. Manage your profile, preferences, data sources, and account.",
      "/settings",
    ],
    [
      "Data quality. Review coverage gaps, source overlap, sync freshness, unusual observations, and manual entries.",
      "/data-quality",
    ],
    ["Cycle tracking. Review provider-sourced cycle starts and phase estimates.", "/cycle"],
  ] as const)("opens %s from an accessible link", async (label, route) => {
    const { default: MoreScreen } = await import("../app/more");
    render(<MoreScreen />);

    fireEvent.click(screen.getByRole("link", { name: label }));

    expect(mockPush).toHaveBeenCalledWith(route);
  });
});
