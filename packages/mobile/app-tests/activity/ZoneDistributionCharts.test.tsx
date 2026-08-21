// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { HrZonesChart } from "../../app/activity/ZoneDistributionCharts";

function stripStyle({
  style: _style,
  contentContainerStyle: _contentContainerStyle,
  scrollEnabled: _scrollEnabled,
  ...rest
}: Record<string, unknown>) {
  return rest;
}

vi.mock("react-native", () => ({
  View: ({
    accessibilityElementsHidden,
    accessibilityLabel,
    accessibilityRole,
    children,
    importantForAccessibility,
    ...props
  }: Record<string, unknown>) =>
    React.createElement(
      "div",
      {
        ...stripStyle(props),
        "aria-hidden": accessibilityElementsHidden === true ? "true" : undefined,
        "aria-label": accessibilityLabel,
        "data-important-for-accessibility": importantForAccessibility,
        role: accessibilityRole,
      },
      ...(children != null ? [children] : []),
    ),
  Text: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("span", stripStyle(props), ...(children != null ? [children] : [])),
  ActivityIndicator: () => React.createElement("div", { "data-testid": "loading" }),
  Pressable: ({
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    children,
    onPress,
    ...props
  }: Record<string, unknown>) =>
    React.createElement(
      "button",
      {
        ...stripStyle(props),
        "aria-expanded":
          typeof accessibilityState === "object" &&
          accessibilityState !== null &&
          "expanded" in accessibilityState
            ? String(accessibilityState.expanded)
            : undefined,
        "aria-label": accessibilityLabel,
        onClick: onPress,
        role: accessibilityRole,
        type: "button",
      },
      ...(children != null ? [children] : []),
    ),
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => {
      for (const key of Object.keys(styles)) {
        styles[key] = {};
      }
      return styles;
    },
  },
}));

vi.mock("react-native-svg", () => ({
  __esModule: true,
  default: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("svg", props, ...(children != null ? [children] : [])),
  G: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("g", props, ...(children != null ? [children] : [])),
  Rect: (props: Record<string, unknown>) => React.createElement("rect", props),
  Text: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("text", props, ...(children != null ? [children] : [])),
}));

vi.mock("../../components/ChartTitleWithTooltip", () => ({
  ChartTitleWithTooltip: ({ title }: { title: string }) => React.createElement("span", null, title),
}));

vi.mock("../../theme", () => ({
  colors: {
    surface: "#111",
    surfaceSecondary: "#1a1a1a",
    text: "#fff",
    textSecondary: "#aaa",
    textTertiary: "#666",
    accent: "#00f",
    danger: "#f00",
  },
}));

describe("ZoneDistributionCharts", () => {
  it("renders aligned primary zone labels with subordinate zone names", () => {
    const { container } = render(
      <HrZonesChart
        zones={[
          { zone: 0, label: "Below Zone 1", minPct: 0, maxPct: 50, seconds: 150, percent: 14.3 },
          { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 300, percent: 28.6 },
          { zone: 2, label: "Endurance", minPct: 60, maxPct: 70, seconds: 600, percent: 57.1 },
        ]}
      />,
    );

    expect(screen.getByText("Below Zone 1")).toBeTruthy();
    expect(screen.getByText("Zone 1")).toBeTruthy();
    expect(screen.getByText("Recovery")).toBeTruthy();
    expect(screen.getByText("Zone 2")).toBeTruthy();
    expect(screen.getByText("Endurance")).toBeTruthy();

    const svgTextElements = Array.from(container.querySelectorAll("text"));
    const zoneOneLabel = svgTextElements.find((element) => element.textContent === "Zone 1");
    const zoneOneName = svgTextElements.find((element) => element.textContent === "Recovery");

    expect(zoneOneLabel?.getAttribute("text-anchor")).toBe("end");
    expect(zoneOneLabel?.getAttribute("x")).toBe("140");
    expect(zoneOneName?.getAttribute("font-size")).toBe("10");
  });

  it("provides a VoiceOver summary and exact zone values", () => {
    render(
      <HrZonesChart
        zones={[
          { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 300, percent: 33.3 },
          { zone: 2, label: "Endurance", minPct: 60, maxPct: 70, seconds: 600, percent: 66.7 },
        ]}
      />,
    );

    expect(
      screen.getByRole("image", {
        name: "Heart Rate Zones. Time spent in each heart rate zone.",
      }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "View Heart Rate Zones data" }));
    expect(screen.getByText("Zone 1 · Recovery")).toBeDefined();
    expect(screen.getByText(/33.3%/)).toBeDefined();
    expect(screen.getByText("Zone 2 · Endurance")).toBeDefined();
    expect(screen.getByText(/66.7%/)).toBeDefined();
  });
});
