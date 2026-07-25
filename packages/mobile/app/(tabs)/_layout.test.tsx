import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { getTabIconName, selectedTabBackgroundColor } from "../../lib/tab-selection";
import { colors } from "../../theme";
import TabsLayout, { tabsScreenOptions } from "./_layout";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

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

  it("opens the alerts screen from the global header bell", () => {
    render(<TabsLayout />);

    fireEvent.click(screen.getByRole("button", { name: "Alerts, 1 active" }));

    expect(mockPush).toHaveBeenCalledWith("/alerts");
  });
});
