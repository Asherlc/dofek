import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHttpBatchLink = vi.fn((options: unknown) => ({ type: "batch", options }));
const mockHttpLink = vi.fn((options: unknown) => ({ type: "single", options }));
const mockSplitLink = vi.fn((options: unknown) => ({ type: "split", options }));
const mockCreateClient = vi.fn();
const mockInitBackgroundHealthKitSync = vi.fn().mockResolvedValue(undefined);
const mockTeardownBackgroundHealthKitSync = vi.fn();
const mockInvalidateSyncedHealthData = vi.fn().mockResolvedValue(undefined);
const mockInitBackgroundAccelerometerSync = vi.fn().mockResolvedValue(undefined);
const mockTeardownBackgroundAccelerometerSync = vi.fn();
const mockInitBackgroundWatchSync = vi.fn().mockResolvedValue(undefined);
const mockTeardownBackgroundWatchSync = vi.fn();
const mockTeardownBackgroundWhoopBleSync = vi.fn();
const mockUseWhoopBleSync = vi.fn();
const mockRefreshRemove = vi.fn();
const mockLoadStatusCapability = vi.fn();
const mockLoadPreparation = vi.fn();
let rootAppStateCallback: ((state: AppStateStatus) => void) | null = null;
const { mockPathname, mockRouterReplace } = vi.hoisted(() => ({
  mockPathname: { value: "/" },
  mockRouterReplace: vi.fn(),
}));
const {
  mockFinishStartupPhase,
  mockMarkAppInteractive,
  mockStartStartupPhase,
  mockStartStartupTelemetry,
  mockSetTelemetryRoute,
} = vi.hoisted(() => ({
  mockFinishStartupPhase: vi.fn(),
  mockMarkAppInteractive: vi.fn(),
  mockStartStartupPhase: vi.fn(),
  mockStartStartupTelemetry: vi.fn(),
  mockSetTelemetryRoute: vi.fn(),
}));
interface MockAuthStateValue {
  accountErasureCleanupInProgress?: boolean;
  accountSessionOwnerNonce?: string | null;
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
      accountSessionOwnerNonce: "11111111-1111-4111-8111-111111111111",
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
    usePathname: () => mockPathname.value,
    useRouter: () => ({ push: vi.fn(), replace: mockRouterReplace, back: vi.fn() }),
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

vi.mock("../lib/account-erasure-storage", () => ({
  loadAnyMobileAccountErasurePreparation: (...args: unknown[]) => mockLoadPreparation(...args),
  loadMobileAccountErasureStatusCapability: (...args: unknown[]) =>
    mockLoadStatusCapability(...args),
}));

vi.mock("../components/AccountDeletionStatusScreen", async () => {
  const React = await import("react");
  return {
    AccountDeletionStatusScreen: () => React.createElement("div", null, "Account deletion status"),
  };
});

vi.mock("../lib/background-health-kit-sync", () => ({
  initBackgroundHealthKitSync: (...args: unknown[]) => mockInitBackgroundHealthKitSync(...args),
  teardownBackgroundHealthKitSync: (...args: unknown[]) =>
    mockTeardownBackgroundHealthKitSync(...args),
}));

vi.mock("../lib/invalidate-synced-health-data", () => ({
  invalidateSyncedHealthData: (...args: unknown[]) => mockInvalidateSyncedHealthData(...args),
}));

vi.mock("../lib/background-accelerometer-sync", () => ({
  initBackgroundAccelerometerSync: (...args: unknown[]) =>
    mockInitBackgroundAccelerometerSync(...args),
  teardownBackgroundAccelerometerSync: (...args: unknown[]) =>
    mockTeardownBackgroundAccelerometerSync(...args),
}));

vi.mock("../lib/background-watch-inertial-measurement-unit-sync", () => ({
  initBackgroundWatchInertialMeasurementUnitSync: (...args: unknown[]) =>
    mockInitBackgroundWatchSync(...args),
  teardownBackgroundWatchInertialMeasurementUnitSync: (...args: unknown[]) =>
    mockTeardownBackgroundWatchSync(...args),
  createWatchSyncClient: (client: unknown) => client,
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
  setTelemetryRoute: mockSetTelemetryRoute,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/startup-telemetry", () => ({
  finishStartupPhase: mockFinishStartupPhase,
  markAppInteractive: mockMarkAppInteractive,
  startStartupPhase: mockStartStartupPhase,
  startStartupTelemetry: mockStartStartupTelemetry,
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

const mockGetRequestStatus = vi.fn<() => Promise<string>>();
const mockIsHealthKitAvailable = vi.fn<() => boolean>();
const mockHasEverAuthorized = vi.fn<() => boolean>();
const mockRequestPermissions = vi.fn<() => Promise<boolean>>();

vi.mock("../modules/health-kit", async () => {
  const { createEmptyAnchoredQueryResult } = await import("../modules/health-kit/test-helpers");
  return {
    getRequestStatus: (...args: unknown[]) => mockGetRequestStatus(...args),
    isAvailable: (...args: unknown[]) => mockIsHealthKitAvailable(...args),
    hasEverAuthorized: (...args: unknown[]) => mockHasEverAuthorized(...args),
    requestPermissions: (...args: unknown[]) => mockRequestPermissions(...args),
    completeAnchoredQuery: vi.fn().mockResolvedValue(true),
    queryAnchoredSamples: vi.fn().mockResolvedValue(createEmptyAnchoredQueryResult()),
    queryDailyStatistics: vi.fn().mockResolvedValue([]),
    queryQuantitySamples: vi.fn().mockResolvedValue([]),
    queryWorkouts: vi.fn().mockResolvedValue([]),
    querySleepSamples: vi.fn().mockResolvedValue([]),
    queryWorkoutRoutes: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("./login", () => ({
  default: () => "Sign in",
}));

mockCreateClient.mockImplementation(() => ({
  healthKitSync: {
    deleteQuantitySamples: { mutate: vi.fn().mockResolvedValue({ deleted: 0 }) },
    pushQuantitySamples: { mutate: vi.fn() },
    pushWorkouts: { mutate: vi.fn() },
    pushWorkoutRoutes: { mutate: vi.fn() },
    pushSleepSamples: { mutate: vi.fn() },
  },
  inertialMeasurementUnitSync: {
    pushSamples: { mutate: vi.fn() },
  },
  watchAltitudeSync: {
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
    mockGetRequestStatus.mockResolvedValue("shouldRequest");
    mockIsHealthKitAvailable.mockReturnValue(false);
    mockHasEverAuthorized.mockReturnValue(false);
    mockRequestPermissions.mockResolvedValue(true);
    mockAuthState.value = {
      accountSessionOwnerNonce: "11111111-1111-4111-8111-111111111111",
      user: { id: "user-1" },
      serverUrl: "https://dofek.test",
      isLoading: false,
      sessionToken: "session-token",
      bootstrapError: null,
      logout: mockLogout,
      retryBootstrap: mockRetryBootstrap,
    };
    mockPathname.value = "/settings";
    mockLoadStatusCapability.mockResolvedValue(null);
    mockLoadPreparation.mockResolvedValue(null);
    rootAppStateCallback = null;
    vi.mocked(AppState.addEventListener).mockImplementation((_event, callback) => {
      rootAppStateCallback = callback;
      return { remove: vi.fn() };
    });
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
      expect(mockStartStartupTelemetry).toHaveBeenCalledOnce();
      expect(mockFinishStartupPhase).toHaveBeenCalledWith("javascript", "ready");
      expect(mockStartStartupPhase).toHaveBeenCalledWith("splash-hide");
      expect(mockMarkAppInteractive).toHaveBeenCalledWith({
        serviceBootstrapExpected: true,
      });
      expect(mockSetTelemetryRoute).toHaveBeenCalledWith("/settings");
    });
  });

  it("uses the login route while the authenticated shell is unauthenticated", async () => {
    mockAuthState.value = {
      user: null,
      serverUrl: "https://dofek.test",
      isLoading: false,
      sessionToken: null,
      bootstrapError: null,
      logout: mockLogout,
      retryBootstrap: mockRetryBootstrap,
    };
    const RootLayout = await importRootLayout();

    render(<RootLayout />);

    await waitFor(() => {
      expect(mockSetTelemetryRoute).toHaveBeenCalledWith("/login");
    });
  });

  it("keeps the active pathname while auth is still restoring", async () => {
    mockAuthState.value = {
      user: null,
      serverUrl: "https://dofek.test",
      isLoading: true,
      sessionToken: null,
      bootstrapError: null,
      logout: mockLogout,
      retryBootstrap: mockRetryBootstrap,
    };
    const RootLayout = await importRootLayout();

    render(<RootLayout />);

    await waitFor(() => {
      expect(mockSetTelemetryRoute).toHaveBeenCalledWith("/settings");
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

  it("shows the public deletion-status screen after a cold restart with a saved capability", async () => {
    mockAuthState.value = {
      user: null,
      serverUrl: "https://dofek.test",
      isLoading: false,
      sessionToken: null,
      bootstrapError: null,
      logout: mockLogout,
      retryBootstrap: mockRetryBootstrap,
    };
    mockLoadStatusCapability.mockResolvedValue({
      cleanupOwnerNonce: "11111111-1111-4111-8111-111111111111",
      requestId: "11111111-1111-4111-8111-111111111111",
      statusToken: "s".repeat(43),
    });
    const RootLayout = await importRootLayout();

    const rendered = render(<RootLayout />);

    expect(await rendered.findByText("Account deletion status")).toBeTruthy();
    expect(rendered.queryByText("Sign in")).toBeNull();
  });

  it("allows direct unauthenticated access to the public deletion-status route", async () => {
    mockAuthState.value = {
      user: null,
      serverUrl: "https://dofek.test",
      isLoading: false,
      sessionToken: null,
      bootstrapError: null,
      logout: mockLogout,
      retryBootstrap: mockRetryBootstrap,
    };
    mockPathname.value = "/account-deletion";
    const RootLayout = await importRootLayout();

    const rendered = render(<RootLayout />);

    expect(await rendered.findByText("Account deletion status")).toBeTruthy();
  });

  it("does not expose sign-in while accepted deletion cleanup is still running", async () => {
    mockAuthState.value = {
      accountErasureCleanupInProgress: true,
      user: null,
      serverUrl: "https://dofek.test",
      isLoading: false,
      sessionToken: null,
      bootstrapError: null,
      logout: mockLogout,
      retryBootstrap: mockRetryBootstrap,
    };
    const RootLayout = await importRootLayout();

    const rendered = render(<RootLayout />);

    expect(await rendered.findByText("Finishing account deletion cleanup…")).toBeTruthy();
    expect(rendered.queryByText("Sign in")).toBeNull();
    expect(mockInitBackgroundHealthKitSync).not.toHaveBeenCalled();
    expect(mockInitBackgroundAccelerometerSync).not.toHaveBeenCalled();
    expect(mockInitBackgroundWatchSync).not.toHaveBeenCalled();
    expect(mockUseWhoopBleSync).not.toHaveBeenCalled();
  });

  it("blocks a later authenticated account and all producers while cleanup is pending", async () => {
    mockLoadStatusCapability.mockResolvedValue({
      cleanupOwnerNonce: "11111111-1111-4111-8111-111111111111",
      localCleanupPending: true,
      requestId: "11111111-1111-4111-8111-111111111111",
      statusToken: "s".repeat(43),
    });
    const RootLayout = await importRootLayout();

    const rendered = render(<RootLayout />);

    expect(await rendered.findByText("Account deletion status")).toBeTruthy();
    expect(mockInitBackgroundHealthKitSync).not.toHaveBeenCalled();
    expect(mockInitBackgroundAccelerometerSync).not.toHaveBeenCalled();
    expect(mockInitBackgroundWatchSync).not.toHaveBeenCalled();
    expect(mockUseWhoopBleSync).not.toHaveBeenCalled();
  });

  it("keeps producers gated after a locked restore and retries cleanup state on foreground", async () => {
    mockLoadStatusCapability
      .mockRejectedValueOnce(new Error("User interaction is not allowed"))
      .mockResolvedValue({
        cleanupOwnerNonce: "11111111-1111-4111-8111-111111111111",
        localCleanupPending: true,
        requestId: "11111111-1111-4111-8111-111111111111",
        statusToken: "s".repeat(43),
      });
    const RootLayout = await importRootLayout();
    const rendered = render(<RootLayout />);

    await waitFor(() => expect(mockLoadStatusCapability).toHaveBeenCalledOnce());
    expect(mockInitBackgroundHealthKitSync).not.toHaveBeenCalled();
    expect(mockInitBackgroundAccelerometerSync).not.toHaveBeenCalled();
    rootAppStateCallback?.("active");

    expect(await rendered.findByText("Account deletion status")).toBeTruthy();
    expect(mockInitBackgroundHealthKitSync).not.toHaveBeenCalled();
    expect(mockInitBackgroundAccelerometerSync).not.toHaveBeenCalled();
    expect(mockInitBackgroundWatchSync).not.toHaveBeenCalled();
    expect(mockUseWhoopBleSync).not.toHaveBeenCalled();
  });

  it("does not let an old account cleanup gate or purge a later session generation", async () => {
    mockAuthState.value = {
      accountSessionOwnerNonce: "22222222-2222-4222-8222-222222222222",
      user: { id: "user-2" },
      serverUrl: "https://dofek.test",
      isLoading: false,
      sessionToken: "user-2-session",
      bootstrapError: null,
      logout: mockLogout,
      retryBootstrap: mockRetryBootstrap,
    };
    mockLoadStatusCapability.mockResolvedValue({
      cleanupOwnerNonce: "11111111-1111-4111-8111-111111111111",
      localCleanupPending: true,
      requestId: "11111111-1111-4111-8111-111111111111",
      statusToken: "s".repeat(43),
    });
    const RootLayout = await importRootLayout();

    const rendered = render(<RootLayout />);

    await waitFor(() => expect(mockLoadStatusCapability).toHaveBeenCalled());
    expect(rendered.queryByText("Account deletion status")).toBeNull();
    await waitFor(() => expect(mockInitBackgroundHealthKitSync).toHaveBeenCalled());
  });

  it("tears down background HealthKit sync on unmount", async () => {
    const RootLayout = await importRootLayout();

    const rendered = render(<RootLayout />);

    await waitFor(() => {
      expect(mockInitBackgroundHealthKitSync).toHaveBeenCalled();
    });

    rendered.unmount();

    await waitFor(() => {
      expect(mockTeardownBackgroundHealthKitSync).toHaveBeenCalled();
      expect(mockTeardownBackgroundAccelerometerSync).toHaveBeenCalled();
      expect(mockTeardownBackgroundWatchSync).toHaveBeenCalled();
      expect(mockTeardownBackgroundWhoopBleSync).toHaveBeenCalled();
      expect(mockRefreshRemove).toHaveBeenCalled();
    });
  });

  it("initializes authenticated background sync after interactions settle", async () => {
    const RootLayout = await importRootLayout();

    render(<RootLayout />);

    await waitFor(() => {
      expect(mockInitBackgroundHealthKitSync).toHaveBeenCalledOnce();
      expect(mockInitBackgroundAccelerometerSync).toHaveBeenCalledOnce();
      expect(mockInitBackgroundWatchSync).toHaveBeenCalledOnce();
      expect(mockUseWhoopBleSync).toHaveBeenCalledOnce();
      expect(mockStartStartupPhase).toHaveBeenCalledWith("service-bootstrap");
      expect(mockFinishStartupPhase).toHaveBeenCalledWith("service-bootstrap", "ready");
    });
  });

  it("uses targeted invalidation after the canonical HealthKit sync completes", async () => {
    const RootLayout = await importRootLayout();

    render(<RootLayout />);

    await waitFor(() => {
      expect(mockInitBackgroundHealthKitSync).toHaveBeenCalledOnce();
    });
    const onSyncComplete = mockInitBackgroundHealthKitSync.mock.calls[0]?.[1];
    if (typeof onSyncComplete !== "function") {
      throw new Error("Expected a HealthKit sync completion callback");
    }

    await onSyncComplete();

    expect(mockInvalidateSyncedHealthData).toHaveBeenCalledOnce();
  });

  it("does not automatically request HealthKit permissions when new types need authorization", async () => {
    mockIsHealthKitAvailable.mockReturnValue(true);
    mockHasEverAuthorized.mockReturnValue(true);
    mockGetRequestStatus.mockResolvedValue("shouldRequest");

    const RootLayout = await importRootLayout();
    render(<RootLayout />);

    await waitFor(() => {
      expect(mockInitBackgroundHealthKitSync).toHaveBeenCalled();
    });

    expect(mockGetRequestStatus).not.toHaveBeenCalled();
    expect(mockRequestPermissions).not.toHaveBeenCalled();
  });

  it("does not automatically request HealthKit permissions when the local marker is unknown", async () => {
    mockIsHealthKitAvailable.mockReturnValue(true);
    mockHasEverAuthorized.mockReturnValue(false);
    mockGetRequestStatus.mockResolvedValue("shouldRequest");

    const RootLayout = await importRootLayout();
    render(<RootLayout />);

    await waitFor(() => {
      expect(mockInitBackgroundHealthKitSync).toHaveBeenCalled();
    });

    expect(mockGetRequestStatus).not.toHaveBeenCalled();
    expect(mockRequestPermissions).not.toHaveBeenCalled();
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
    expect(queryCondition({ type: "query", path: "mobileDashboard.dashboardV2" })).toBe(true);
    expect(queryCondition({ type: "query", path: "mobileDashboard.recovery" })).toBe(true);
    expect(queryCondition({ type: "query", path: "mobileDashboard.training" })).toBe(true);
    expect(queryCondition({ type: "query", path: "processing.status" })).toBe(false);
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
