// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
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
  Switch: ({
    value,
    onValueChange,
    disabled,
    ...props
  }: Record<string, unknown> & {
    onValueChange?: (val: boolean) => void;
    disabled?: boolean;
  }) =>
    React.createElement("input", {
      ...stripStyle(props),
      type: "checkbox",
      checked: value,
      disabled,
      onChange: () => onValueChange?.(!value),
    }),
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

vi.mock("../modules/whoop-ble", () => ({
  isBluetoothAvailable: () => false,
  getConnectionState: () => "idle",
  getBluetoothState: () => "poweredOff",
  getBufferedSampleCount: () => 0,
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

let mockSettingsGetData: { key: string; value: unknown } | null = null;
const mockSettingsRefetch = vi.fn();
const mockMutate = vi.fn();
const mockSetData = vi.fn(
  (_input: { key: string }, data: { key: string; value: unknown } | null) => {
    mockSettingsGetData = data;
  },
);
let mockMutationCallbacks: {
  onMutate?: (variables: { key: string; value: unknown }) => void;
} = {};

vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      settings: {
        get: {
          setData: (input: { key: string }, data: { key: string; value: unknown } | null) =>
            mockSetData(input, data),
        },
      },
    }),
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
    settings: {
      get: {
        useQuery: () => ({
          data: mockSettingsGetData,
          isLoading: false,
          refetch: mockSettingsRefetch,
        }),
      },
      set: {
        useMutation: (opts?: {
          onMutate?: (variables: { key: string; value: unknown }) => void;
        }) => {
          if (opts?.onMutate) {
            mockMutationCallbacks.onMutate = opts.onMutate;
          }
          return {
            mutate: (
              input: { key: string; value: unknown },
              callOpts?: { onSuccess?: () => void; onError?: () => void },
            ) => {
              // Fire onMutate synchronously like react-query does
              mockMutationCallbacks.onMutate?.(input);
              mockMutate(input, callOpts);
            },
            isPending: false,
          };
        },
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
    appStateCallback = null;
    mockSettingsGetData = null;
    mockMutate.mockReset();
    mockSetData.mockClear();
    mockSettingsRefetch.mockReset();
    mockMutationCallbacks = {};
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

  it("optimistically updates the WHOOP IMU toggle without waiting for server", async () => {
    // Start with the toggle OFF
    mockSettingsGetData = null;

    const { unmount } = render(
      React.createElement((await import("./inertial-measurement-unit")).default),
    );

    // Find the switch — it should be unchecked
    const toggle = screen.getByRole("checkbox");
    expect(toggle).toHaveProperty("checked", false);

    // Simulate toggling ON — fireEvent.click triggers onChange on checkboxes
    await act(async () => {
      fireEvent.click(toggle);
    });

    // The optimistic update should set the query data immediately
    expect(mockSetData).toHaveBeenCalledWith(
      { key: "whoopAlwaysOnImu" },
      { key: "whoopAlwaysOnImu", value: true },
    );

    // The mutation should also be called to persist
    expect(mockMutate).toHaveBeenCalledWith(
      { key: "whoopAlwaysOnImu", value: true },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

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
