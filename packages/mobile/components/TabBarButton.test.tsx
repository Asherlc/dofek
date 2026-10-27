import { fireEvent, render, screen } from "@testing-library/react";
import type { BottomTabBarButtonProps } from "expo-router/tabs";
import { Pressable, Text } from "react-native";
import { describe, expect, it, vi } from "vitest";
import { TabBarButton } from "./TabBarButton";

vi.mock("expo-router/react-navigation", () => ({
  PlatformPressable: (props: BottomTabBarButtonProps) => (
    <Pressable {...props} accessibilityRole="button" accessibilityLabel={props["aria-label"]} />
  ),
}));

const navigatorStyle = {
  flex: 1,
  backgroundColor: "#e0eee5",
  borderRadius: 0,
  padding: 5,
  flexDirection: "column",
  justifyContent: "flex-start",
} as const;

function tabProps(): BottomTabBarButtonProps {
  return {
    "aria-label": "Today",
    "aria-selected": true,
    role: "button",
    style: navigatorStyle,
    children: <Text>Today</Text>,
  };
}

describe("TabBarButton", () => {
  it("rounds the selected button itself and centers its contents within the highlight", () => {
    render(<TabBarButton {...tabProps()} />);

    const button = screen.getByRole("button", { name: "Today" });
    expect(button.style.borderRadius).toBe("12px");
    expect(button.style.justifyContent).toBe("center");
    expect(button.style.paddingTop).toBe("3px");
    expect(button.style.paddingBottom).toBe("3px");
    expect(button.style.backgroundColor).toBe("rgb(224, 238, 229)");
    expect(button.contains(screen.getByText("Today"))).toBe(true);
  });

  it("preserves the navigator's selection state and press handler", () => {
    const onPress = vi.fn();
    const { rerender } = render(<TabBarButton {...tabProps()} onPress={onPress} />);

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(onPress).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Today" }).getAttribute("aria-selected")).toBe(
      "true",
    );

    rerender(<TabBarButton {...tabProps()} aria-selected={false} />);
    expect(screen.getByRole("button", { name: "Today" }).getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  it("preserves the navigator's horizontal layout for landscape and tablet tabs", () => {
    render(<TabBarButton {...tabProps()} style={[navigatorStyle, { flexDirection: "row" }]} />);

    expect(screen.getByRole("button", { name: "Today" }).style.flexDirection).toBe("row");
  });
});
