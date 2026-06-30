import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHttpBatchLink = vi.fn((options: unknown) => ({ type: "batch", options }));
const mockHttpLink = vi.fn((options: unknown) => ({ type: "single", options }));
const mockSplitLink = vi.fn((options: unknown) => ({ type: "split", options }));
const mockCreateClient = vi.fn();
const mockInitBackgroundHealthKitSync = vi.fn().mockResolvedValue(undefined);
const mockTeardownBackgroundHealthKitSync = vi.fn();
const mockInitBackgroundAccelerometerSync = vi.fn().mockResolvedValue(undefined);
const mockInitBackgroundWatchSync = vi.fn().mockResolvedValue(undefined);
const mockTeardownBackgroundWhoopBleSync = vi.fn();
const mockUseWhoopBleSync = vi.fn();
const mockRefreshRemove = vi.fn();
interface MockAuthStateValue {
  user: { id: string } | null;
  serverUrl: string;
  isLoading: boolean;
  sessionToken: string | null;
  bootstrapError: string | null;
  logout: () => Promise<void>;
  retryBootstrap: () => Promise<void>;
}

const { mockAuthState, mockLogout, mockRetryBootstrap } = vi.hoisted(() => {
  const logout = vi.fn(async () => undefined);
  const retryBootstrap = vi.fn(async () => undefined);
  const authState: { value: MockAuthStateValue } = {
    value: {
      user: { id: "user-1" },
      serverUrl: "https://dofek.test",
      isLoading: false,
      sessionToken: "session-token",
      bootstrapError: null,
      logout,
      retryBootstrap,
    },
  };
  return { mockAuthState: authState, mockLogout: logout, mockRetryBootstrap: retryBootstrap };
});
const { mockPreventAutoHideAsync, mockHideAsync } = vi.hoisted(() => ({
  mockPreventAutoHideAsync: vi.fn(() => Promise.resolve()),
  mockHideAsync: vi.fn(() => Promise.resolve()),
}));

vi.mock("@sentry/react-native", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  wrap: vi.fn((component: unknown) => component),
}));

vi.mock("@trpc/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@trpc/client")>();
  return {
    ...original,
    httpBatchLink: (...args: unknown[]) => mockHttpBatchLink(...args),
    httpLink: (...args: unknown[]) => mockHttpLink(...args),
    splitLink: (...args: unknown[]) => mockSplitLink(...args),
  };
});

vi.mock("expo-router", async () => {
  const React = await import("react");

  const Stack = ({ children }: { children: ReactNode }) =>
    React.createElement("Stack", null, children);
  Stack.Screen = () => null;

  return {
    Stack,
  };
});

vi.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: (...args: unknown[]) => mockPreventAutoHideAsync(...args),
  hideAsync: (...args: unknown[]) => mockHideAsync(...args),
}));

vi.mock("../lib/auth-context", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => mockAuthState.value,
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

async function importRootLayout() {
  vi.resetModules();
  return (await import("./_layout")).default;
}

describe("RootLayout background cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState.value = {
      user: { id: "user-1" },
      serverUrl: "https://dofek.test",
      isLoading: false,
      sessionToken: "session-token",
      bootstrapError: null,
      logout: mockLogout,
      retryBootstrap: mockRetryBootstrap,
    };
  });

  it("keeps the native splash screen visible until the root layout can render", async () => {
    await importRootLayout();

    expect(mockPreventAutoHideAsync).toHaveBeenCalledOnce();
  });

  it("hides the native splash screen after auth state is resolved", async () => {
    const RootLayout = await importRootLayout();

    render(<RootLayout />);

    await waitFor(() => {
      expect(mockHideAsync).toHaveBeenCalledOnce();
    });
  });

  it("shows bootstrap failure instead of login when auth restore fails", async () => {
    mockAuthState.value = {
      user: null,
      serverUrl: "https://dofek.test",
      isLoading: false,
      sessionToken: null,
      bootstrapError: "Database unavailable",
      logout: mockLogout,
      retryBootstrap: mockRetryBootstrap,
    };
    const RootLayout = await importRootLayout();

    const rendered = render(<RootLayout />);

    await waitFor(() => {
      expect(rendered.getByText("Database unavailable")).toBeTruthy();
    });
  });

  it("lets users sign out from bootstrap failure", async () => {
    mockAuthState.value = {
      user: null,
      serverUrl: "https://dofek.test",
      isLoading: false,
      sessionToken: null,
      bootstrapError: "Database unavailable",
      logout: mockLogout,
      retryBootstrap: mockRetryBootstrap,
    };
    const RootLayout = await importRootLayout();

    const rendered = render(<RootLayout />);
    fireEvent.click(rendered.getByText("Sign out"));

    expect(mockLogout).toHaveBeenCalledOnce();
  });

  it("lets users retry bootstrap failure", async () => {
    mockAuthState.value = {
      user: null,
      serverUrl: "https://dofek.test",
      isLoading: false,
      sessionToken: null,
      bootstrapError: "Database unavailable",
      logout: mockLogout,
      retryBootstrap: mockRetryBootstrap,
    };
    const RootLayout = await importRootLayout();

    const rendered = render(<RootLayout />);
    fireEvent.click(rendered.getByText("Try again"));

    expect(mockRetryBootstrap).toHaveBeenCalledOnce();
  });

  it("tears down background HealthKit sync on unmount", async () => {
    const RootLayout = await importRootLayout();

    const rendered = render(<RootLayout />);

    await waitFor(() => {
      expect(mockInitBackgroundHealthKitSync).toHaveBeenCalled();
    });

    rendered.unmount();

    expect(mockTeardownBackgroundHealthKitSync).toHaveBeenCalled();
    expect(mockTeardownBackgroundWhoopBleSync).toHaveBeenCalled();
    expect(mockRefreshRemove).toHaveBeenCalled();
  });

  it("defers authenticated background sync setup until after the first render pass", async () => {
    vi.useFakeTimers();
    try {
      const RootLayout = await importRootLayout();

      render(<RootLayout />);

      expect(mockInitBackgroundHealthKitSync).not.toHaveBeenCalled();
      expect(mockInitBackgroundAccelerometerSync).not.toHaveBeenCalled();
      expect(mockInitBackgroundWatchSync).not.toHaveBeenCalled();
      expect(mockUseWhoopBleSync).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockInitBackgroundHealthKitSync).toHaveBeenCalledOnce();
      expect(mockInitBackgroundAccelerometerSync).toHaveBeenCalledOnce();
      expect(mockInitBackgroundWatchSync).toHaveBeenCalledOnce();
      expect(mockUseWhoopBleSync).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses an unbatched link for the initial mobile dashboard query", async () => {
    const RootLayout = await importRootLayout();

    render(<RootLayout />);

    await waitFor(() => {
      expect(mockCreateClient).toHaveBeenCalledOnce();
    });

    expect(mockHttpBatchLink).toHaveBeenCalledOnce();
    expect(mockHttpLink).toHaveBeenCalledOnce();
    expect(mockSplitLink).toHaveBeenCalledTimes(2);

    const mutationSplitOptions = mockSplitLink.mock.calls[1]?.[0];
    const querySplitOptions = mockSplitLink.mock.calls[0]?.[0];
    if (typeof mutationSplitOptions !== "object" || mutationSplitOptions == null) {
      throw new Error("Expected mutation split link options");
    }
    if (typeof querySplitOptions !== "object" || querySplitOptions == null) {
      throw new Error("Expected query split link options");
    }
    const mutationCondition = Reflect.get(mutationSplitOptions, "condition");
    const queryCondition = Reflect.get(querySplitOptions, "condition");
    if (typeof mutationCondition !== "function" || typeof queryCondition !== "function") {
      throw new Error("Expected split link conditions");
    }

    expect(mutationCondition({ type: "mutation" })).toBe(true);
    expect(mutationCondition({ type: "query" })).toBe(false);
    expect(queryCondition({ type: "query", path: "mobileDashboard.dashboard" })).toBe(true);
    expect(queryCondition({ type: "query", path: "mobileDashboard.recovery" })).toBe(true);
    expect(queryCondition({ type: "query", path: "mobileDashboard.training" })).toBe(true);
    expect(queryCondition({ type: "query", path: "anomalyDetection.check" })).toBe(false);
    expect(queryCondition({ type: "mutation", path: "mobileDashboard.dashboard" })).toBe(false);
    const mutationLink = Reflect.get(mutationSplitOptions, "true");
    const defaultQueryLink = Reflect.get(querySplitOptions, "false");
    const dashboardQueryLink = Reflect.get(querySplitOptions, "true");

    expect(mutationLink).toEqual({
      type: "batch",
      options: expect.anything(),
    });
    expect(defaultQueryLink).toEqual({
      type: "batch",
      options: expect.anything(),
    });
    expect(dashboardQueryLink).toEqual({
      type: "single",
      options: expect.anything(),
    });
  });
});
