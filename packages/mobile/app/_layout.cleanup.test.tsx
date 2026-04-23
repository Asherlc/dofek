import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mockCreateClient = vi.fn();
const mockInitBackgroundHealthKitSync = vi.fn().mockResolvedValue(undefined);
const mockTeardownBackgroundHealthKitSync = vi.fn();
const mockInitBackgroundAccelerometerSync = vi.fn().mockResolvedValue(undefined);
const mockInitBackgroundWatchSync = vi.fn().mockResolvedValue(undefined);
const mockTeardownBackgroundWhoopBleSync = vi.fn();
const mockUseWhoopBleSync = vi.fn();
const mockRefreshRemove = vi.fn();

vi.mock("@sentry/react-native", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  wrap: vi.fn((component: unknown) => component),
}));

vi.mock("expo-router", async () => {
  const React = await import("react");

  const Stack = ({ children }: { children: ReactNode }) =>
    React.createElement("Stack", null, children);
  Stack.Screen = () => null;

  return {
    Stack,
  };
});

vi.mock("../lib/auth-context", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({
    user: { id: "user-1" },
    serverUrl: "https://dofek.test",
    isLoading: false,
    sessionToken: "session-token",
  }),
}));

vi.mock("../lib/background-health-kit-sync", () => ({
  initBackgroundHealthKitSync: (...args: unknown[]) => mockInitBackgroundHealthKitSync(...args),
  teardownBackgroundHealthKitSync: (...args: unknown[]) =>
    mockTeardownBackgroundHealthKitSync(...args),
}));

vi.mock("../lib/background-accelerometer-sync", () => ({
  initBackgroundAccelerometerSync: (...args: unknown[]) =>
    mockInitBackgroundAccelerometerSync(...args),
}));

vi.mock("../lib/background-watch-inertial-measurement-unit-sync", () => ({
  initBackgroundWatchInertialMeasurementUnitSync: (...args: unknown[]) =>
    mockInitBackgroundWatchSync(...args),
}));

vi.mock("../lib/background-whoop-ble-sync", () => ({
  syncWhoopBle: vi.fn(),
  teardownBackgroundWhoopBleSync: (...args: unknown[]) =>
    mockTeardownBackgroundWhoopBleSync(...args),
}));

vi.mock("../lib/server", () => ({
  getTrpcUrl: () => "https://dofek.test/api/trpc",
}));

vi.mock("../lib/telemetry", () => ({
  initTelemetry: vi.fn(),
  captureException: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    createClient: (...args: unknown[]) => mockCreateClient(...args),
    Provider: ({ children }: { children: ReactNode }) => children,
  },
}));

vi.mock("../lib/useWhoopBleSync", () => ({
  useWhoopBleSync: (...args: unknown[]) => mockUseWhoopBleSync(...args),
}));

vi.mock("../lib/version-headers", () => ({
  getVersionHeaders: () => ({
    "x-app-version": "1.0.0",
    "x-assets-version": "test-update-id",
  }),
}));

vi.mock("../modules/background-refresh", () => ({
  addBackgroundRefreshListener: () => ({ remove: mockRefreshRemove }),
  scheduleRefresh: vi.fn(),
}));

vi.mock("../modules/whoop-ble", () => ({
  addConnectionStateListener: vi.fn(),
  confirmRealtimeDataDrain: vi.fn(),
  confirmSamplesDrain: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  findWhoop: vi.fn(),
  isBluetoothAvailable: vi.fn(),
  peekBufferedRealtimeData: vi.fn(),
  peekBufferedSamples: vi.fn(),
  startImuStreaming: vi.fn(),
  stopImuStreaming: vi.fn(),
}));

vi.mock("./login", () => ({
  default: () => null,
}));

mockCreateClient.mockImplementation(() => ({
  healthKitSync: {
    pushQuantitySamples: { mutate: vi.fn() },
    pushWorkouts: { mutate: vi.fn() },
    pushWorkoutRoutes: { mutate: vi.fn() },
    pushSleepSamples: { mutate: vi.fn() },
  },
  inertialMeasurementUnitSync: {
    pushSamples: { mutate: vi.fn() },
  },
  whoopBleSync: {
    pushRealtimeData: { mutate: vi.fn() },
  },
}));

import RootLayout from "./_layout";

describe("RootLayout background cleanup", () => {
  it("tears down background HealthKit sync on unmount", async () => {
    const rendered = render(<RootLayout />);

    await waitFor(() => {
      expect(mockInitBackgroundHealthKitSync).toHaveBeenCalled();
    });

    rendered.unmount();

    expect(mockTeardownBackgroundHealthKitSync).toHaveBeenCalled();
    expect(mockTeardownBackgroundWhoopBleSync).toHaveBeenCalled();
    expect(mockRefreshRemove).toHaveBeenCalled();
  });
});
