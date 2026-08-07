import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import TabsLayout, { tabsScreenOptions } from "../../app/(tabs)/_layout";
import { getTabIconName, selectedTabBackgroundColor } from "../../lib/tab-selection";
import { colors } from "../../theme";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

function relativeLuminance(hexColor: string): number {
  const linearChannel = (start: number) => {
    const channel = Number.parseInt(hexColor.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearChannel(1) + 0.7152 * linearChannel(3) + 0.0722 * linearChannel(5);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

vi.mock("@expo/vector-icons", () => ({
  Ionicons: () => null,
}));

vi.mock("expo-router", () => ({
  Tabs: Object.assign(
    ({ screenOptions }: { screenOptions: { headerRight?: () => ReactNode } }) =>
      screenOptions.headerRight?.(),
    { Screen: () => null },
  ),
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("../../lib/useProcessingAlerts", () => ({
  useProcessingAlerts: () => ({
    data: {
      alerts: [{ id: "operation-1:providers" }],
    },
  }),
}));

describe("tab layout selected state", () => {
  it("uses filled icons for focused tabs and outline icons for unfocused tabs", () => {
    expect(getTabIconName("index", true)).toBe("today");
    expect(getTabIconName("index", false)).toBe("today-outline");
    expect(getTabIconName("recovery", true)).toBe("pulse");
    expect(getTabIconName("recovery", false)).toBe("pulse-outline");
    expect(getTabIconName("strain", true)).toBe("barbell");
    expect(getTabIconName("strain", false)).toBe("barbell-outline");
    expect(getTabIconName("food", true)).toBe("nutrition");
    expect(getTabIconName("food", false)).toBe("nutrition-outline");
  });

  it("sets a distinct active tab background color", () => {
    expect(selectedTabBackgroundColor).toBe(colors.surfaceSecondary);
  });

  it("keeps the tab bar above screen content", () => {
    expect(tabsScreenOptions.tabBarStyle).toMatchObject({
      backgroundColor: colors.background,
      elevation: 8,
      position: "relative",
      zIndex: 1,
    });
  });

  it("meets AA contrast for inactive tab labels", () => {
    expect(
      contrastRatio(tabsScreenOptions.tabBarInactiveTintColor, colors.background),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("opens the alerts screen from the global header bell", () => {
    render(<TabsLayout />);

    fireEvent.click(screen.getByRole("button", { name: "Alerts, 1 active" }));

    expect(mockPush).toHaveBeenCalledWith("/alerts");
  });

  it("opens More from the global tab header", () => {
    render(<TabsLayout />);

    fireEvent.click(screen.getByRole("button", { name: "More" }));

    expect(mockPush).toHaveBeenCalledWith("/more");
  });
});
