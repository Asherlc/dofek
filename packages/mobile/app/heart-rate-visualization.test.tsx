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
  Stack: {
    Screen: () => null,
  },
}));

vi.mock("../modules/whoop-ble", () => ({
  isBluetoothAvailable: () => false,
  findWhoop: () => Promise.resolve(null),
  connect: () => Promise.resolve(true),
  disconnect: vi.fn(),
  startRealtimeHr: () => Promise.resolve(true),
  getBufferedRealtimeData: () => Promise.resolve([]),
}));

vi.mock("../lib/telemetry", () => ({
  captureException: vi.fn(),
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

describe("HeartRateVisualizationScreen", () => {
  it("renders initial disconnected state", async () => {
    const { default: HeartRateVisualizationScreen } = await import("./heart-rate-visualization");

    render(<HeartRateVisualizationScreen />);

    expect(screen.getByText("Heart Rate")).toBeTruthy();
    expect(screen.getByText("--")).toBeTruthy();
    expect(screen.getByText("bpm")).toBeTruthy();
    expect(screen.getByText("Start Streaming")).toBeTruthy();
    expect(screen.getByText("disconnected")).toBeTruthy();
  });

  it("shows placeholder text before streaming", async () => {
    const { default: HeartRateVisualizationScreen } = await import("./heart-rate-visualization");

    render(<HeartRateVisualizationScreen />);

    expect(screen.getByText("Start streaming to see heart rate")).toBeTruthy();
  });
});
