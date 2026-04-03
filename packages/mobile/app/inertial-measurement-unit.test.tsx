// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetMotionAuthorizationStatus = vi.fn(() => "notDetermined");
const mockRequestMotionPermission = vi.fn(() => Promise.resolve("authorized" as const));
const mockIsAccelerometerRecordingAvailable = vi.fn(() => true);
const mockIsRecordingActive = vi.fn(() => false);

let appStateCallback: ((state: string) => void) | null = null;

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
  TouchableOpacity: ({ children, ...props }: Record<string, unknown>) =>
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
  AppState: {
    addEventListener: vi
      .fn()
      .mockImplementation((_event: string, callback: (state: string) => void) => {
        appStateCallback = callback;
        return { remove: vi.fn() };
      }),
  },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

vi.mock("react-native-svg", () => ({
  __esModule: true,
  default: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("svg", props, ...(children != null ? [children] : [])),
  Rect: (props: Record<string, unknown>) => React.createElement("rect", props),
  Text: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("text", props, ...(children != null ? [children] : [])),
}));

vi.mock("expo-router", () => ({
  Stack: {
    Screen: () => null,
  },
}));

vi.mock("../modules/core-motion", () => ({
  isAccelerometerRecordingAvailable: (...args: unknown[]) =>
    mockIsAccelerometerRecordingAvailable(...args),
  getMotionAuthorizationStatus: (...args: unknown[]) => mockGetMotionAuthorizationStatus(...args),
  requestMotionPermission: (...args: unknown[]) => mockRequestMotionPermission(...args),
  isRecordingActive: (...args: unknown[]) => mockIsRecordingActive(...args),
}));

const mockGetConnectionState = vi.fn(() => "idle");
const mockGetBluetoothState = vi.fn(() => "poweredOff");

vi.mock("../modules/whoop-ble", () => ({
  isBluetoothAvailable: () => false,
  getConnectionState: (...args: unknown[]) => mockGetConnectionState(...args),
  getBluetoothState: (...args: unknown[]) => mockGetBluetoothState(...args),
  getBufferedSampleCount: () => 0,
  getDataPathStats: () => ({
    dataNotificationCount: 0,
    cmdNotificationCount: 0,
    totalFramesParsed: 0,
    totalSamplesExtracted: 0,
    droppedForNonStreaming: 0,
    emptyExtractions: 0,
    bufferOverflows: 0,
    packetTypes: "",
    lastCommandResponse: "none",
    connectionState: "idle",
    hasDataCharacteristic: false,
    isNotifying: false,
    hasCmdCharacteristic: false,
    hasCmdResponseCharacteristic: false,
    lastWriteError: "none",
  }),
}));

const mockGetWatchSyncStatus = vi.fn(() => ({
  isSupported: true,
  isPaired: false,
  isReachable: false,
  isWatchAppInstalled: false,
  pendingFileCount: 0,
}));

vi.mock("../modules/watch-motion", () => ({
  getWatchSyncStatus: (...args: unknown[]) => mockGetWatchSyncStatus(...args),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    inertialMeasurementUnit: {
      getSyncStatus: {
        useQuery: () => ({ data: null, isLoading: false }),
      },
      getDailyHeatmap: {
        useQuery: () => ({ data: null, isLoading: false }),
      },
      getCoverageTimeline: {
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
    border: "#222",
    text: "#fff",
    textSecondary: "#aaa",
    textTertiary: "#666",
    accent: "#00f",
    positive: "#0f0",
    negative: "#f00",
  },
}));

vi.mock("./_layout", () => ({
  rootStackScreenOptions: {},
}));

describe("InertialMeasurementUnitScreen", () => {
  beforeEach(() => {
    mockGetMotionAuthorizationStatus.mockReturnValue("notDetermined");
    mockRequestMotionPermission.mockResolvedValue("authorized");
    mockIsAccelerometerRecordingAvailable.mockReturnValue(true);
    mockIsRecordingActive.mockReturnValue(false);
    mockGetConnectionState.mockReturnValue("idle");
    mockGetBluetoothState.mockReturnValue("poweredOff");
    appStateCallback = null;
  });

  it("updates permission status when app returns to foreground", async () => {
    // Start with notDetermined
    const { unmount } = render(
      React.createElement((await import("./inertial-measurement-unit")).default),
    );

    expect(screen.getByText("notDetermined")).toBeTruthy();

    // Simulate the user granting permission in iOS settings,
    // then returning to the app
    mockGetMotionAuthorizationStatus.mockReturnValue("authorized");

    await act(async () => {
      appStateCallback?.("active");
    });

    expect(screen.getByText("Granted")).toBeTruthy();

    unmount();
  });

  it("requests permission on mount when status is notDetermined", async () => {
    const { unmount } = render(
      React.createElement((await import("./inertial-measurement-unit")).default),
    );

    expect(mockRequestMotionPermission).toHaveBeenCalled();

    unmount();
  });

  it("shows WHOOP warning and diagnostics when BLE is active", async () => {
    mockGetBluetoothState.mockReturnValue("poweredOn");
    mockGetConnectionState.mockReturnValue("scanning");

    const { unmount } = render(
      React.createElement((await import("./inertial-measurement-unit")).default),
    );

    // Warning should appear in both the error banner and the inline warning
    expect(screen.getAllByText(/Scanning for WHOOP strap/).length).toBeGreaterThanOrEqual(1);

    // Diagnostics block should be visible (connectionState !== "idle")
    expect(screen.getByText("Data Path")).toBeTruthy();

    unmount();
  });

  it("updates Apple Watch status when connectivity changes", async () => {
    vi.useFakeTimers();

    // Start with no Watch paired
    mockGetWatchSyncStatus.mockReturnValue({
      isSupported: true,
      isPaired: false,
      isReachable: false,
      isWatchAppInstalled: false,
      pendingFileCount: 0,
    });

    const { unmount } = render(
      React.createElement((await import("./inertial-measurement-unit")).default),
    );

    // Watch shows "No" for Paired and App Installed
    const initialNoLabels = screen.getAllByText("No");
    expect(initialNoLabels.length).toBeGreaterThanOrEqual(2);

    // Simulate the Watch becoming paired and app installed
    mockGetWatchSyncStatus.mockReturnValue({
      isSupported: true,
      isPaired: true,
      isReachable: true,
      isWatchAppInstalled: true,
      pendingFileCount: 0,
    });

    // Advance past the poll interval
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    // getWatchSyncStatus should have been polled (not just called once at mount)
    // Initial mount + at least one poll tick
    expect(mockGetWatchSyncStatus.mock.calls.length).toBeGreaterThanOrEqual(2);

    // The "Paired" and "App Installed" badges should now show "Yes"
    const yesLabels = screen.getAllByText("Yes");
    expect(yesLabels.length).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
    unmount();
  });
});
