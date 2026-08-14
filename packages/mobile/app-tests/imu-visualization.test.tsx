// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const whoopBleMocks = vi.hoisted(() => ({
  addConnectionStateListener: vi.fn(() => ({ remove: vi.fn() })),
  addOrientationListener: vi.fn(() => ({ remove: vi.fn() })),
  connect: vi.fn(() => Promise.resolve(true)),
  findWhoop: vi.fn(() => Promise.resolve({ id: "whoop-1", name: "WHOOP" })),
  getConnectionState: vi.fn(() => "idle"),
  startImuStreaming: vi.fn(() => Promise.resolve(true)),
}));
const mockCaptureException = vi.hoisted(() => vi.fn());

function stripStyle({
  style: _style,
  contentContainerStyle: _contentStyle,
  ...rest
}: Record<string, unknown>) {
  return rest;
}

vi.mock("react-native", () => ({
  View: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", stripStyle(props), ...(children != null ? [children] : [])),
  Text: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("span", stripStyle(props), ...(children != null ? [children] : [])),
  ScrollView: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", stripStyle(props), ...(children != null ? [children] : [])),
  StyleSheet: {
    create: <Styles extends Record<string, unknown>>(styles: Styles): Styles => styles,
  },
}));

vi.mock("expo-router", () => ({
  Stack: {
    Screen: () => null,
  },
}));

vi.mock("../components/WristModel", () => ({
  WristModel: () => null,
}));

vi.mock("../modules/whoop-ble", () => whoopBleMocks);

vi.mock("../lib/telemetry", () => ({
  captureException: mockCaptureException,
}));

vi.mock("../theme", () => ({
  colors: {
    background: "#000",
    surface: "#111",
    text: "#fff",
    textSecondary: "#aaa",
    positive: "#0f0",
    danger: "#f00",
    green: "#0f0",
    blue: "#00f",
  },
}));

vi.mock("../app/_layout-options", () => ({
  rootStackScreenOptions: {},
}));

import ImuVisualizationScreen from "../app/imu-visualization";

describe("ImuVisualizationScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    whoopBleMocks.getConnectionState.mockReturnValue("idle");
    whoopBleMocks.findWhoop.mockResolvedValue({ id: "whoop-1", name: "WHOOP" });
    whoopBleMocks.connect.mockResolvedValue(true);
    whoopBleMocks.startImuStreaming.mockResolvedValue(true);
  });

  it("reports a best-effort streaming-start failure for an existing connection", async () => {
    const streamingError = new Error("Native streaming failed");
    whoopBleMocks.getConnectionState.mockReturnValue("streaming");
    whoopBleMocks.startImuStreaming.mockRejectedValue(streamingError);

    render(<ImuVisualizationScreen />);

    await waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(streamingError, {
        source: "imu-visualization-start-streaming",
      });
    });
    expect(screen.getByText("streaming")).toBeTruthy();
  });

  it("reports connection failures while preserving the visible error", async () => {
    const connectionError = new Error("Bluetooth connection failed");
    whoopBleMocks.connect.mockRejectedValue(connectionError);

    render(<ImuVisualizationScreen />);

    await waitFor(() => {
      expect(screen.getByText("Bluetooth connection failed")).toBeTruthy();
    });
    expect(mockCaptureException).toHaveBeenCalledWith(connectionError, {
      source: "imu-visualization-connect",
    });
  });
});
