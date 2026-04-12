// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

function stripStyle({ style: _s, contentContainerStyle: _cs, ...rest }: Record<string, unknown>) {
  return rest;
}

vi.mock("react-native", () => ({
  View: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", stripStyle(props), ...(children != null ? [children] : [])),
  Text: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("span", stripStyle(props), ...(children != null ? [children] : [])),
  ScrollView: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", stripStyle(props), ...(children != null ? [children] : [])),
  Pressable: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement(
      "button",
      { ...stripStyle(props), type: "button" },
      ...(children != null ? [children] : []),
    ),
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => {
      for (const key of Object.keys(styles)) {
        styles[key] = {};
      }
      return styles;
    },
    hairlineWidth: 1,
  },
}));

vi.mock("react-native-svg", () => ({
  __esModule: true,
  default: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("svg", props, ...(children != null ? [children] : [])),
  Line: (props: Record<string, unknown>) => React.createElement("line", props),
  Polyline: (props: Record<string, unknown>) => React.createElement("polyline", props),
}));

vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
}));

vi.mock("@dofek/format/format", () => ({
  formatDateYmd: () => "2026-04-12",
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    heartRate: {
      dailyBySource: {
        useQuery: () => ({ data: null, isLoading: false }),
      },
    },
  },
}));

vi.mock("../theme", () => ({
  colors: {
    background: "#000",
    surface: "#111",
    surfaceSecondary: "#1a1a1a",
    text: "#fff",
    textSecondary: "#aaa",
    textTertiary: "#666",
    accent: "#00f",
    positive: "#0f0",
    danger: "#f00",
  },
}));

vi.mock("./_layout", () => ({
  rootStackScreenOptions: {},
}));

describe("DailyHeartRateScreen", () => {
  it("renders with date navigator and empty state", async () => {
    const { default: DailyHeartRateScreen } = await import("./daily-heart-rate");

    render(<DailyHeartRateScreen />);

    expect(screen.getByText("04/12/2026")).toBeTruthy();
    expect(screen.getByText("No heart rate data for this day")).toBeTruthy();
  });
});
