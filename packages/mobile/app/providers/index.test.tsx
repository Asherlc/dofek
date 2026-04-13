// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerActionLabel } from "./provider-card.tsx";

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockUseLocalSearchParams = vi.fn().mockReturnValue({});
const mockSyncMutateAsync = vi.fn();
const mockImportSharedFile = vi.fn();

vi.mock("react-native", () => ({
  View: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => {
    const {
      style: _s,
      contentContainerStyle: _cs,
      activeOpacity: _ao,
      numberOfLines: _nl,
      ...rest
    } = props;
    return React.createElement("div", rest, children);
  },
  Text: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => {
    const { style: _s, numberOfLines: _nl, ...rest } = props;
    return React.createElement("span", rest, children);
  },
  ScrollView: ({
    children,
    ...props
  }: { children?: React.ReactNode } & Record<string, unknown>) => {
    const { style: _s, contentContainerStyle: _cs, refreshControl: _rc, ...rest } = props;
    return React.createElement("div", rest, children);
  },
  RefreshControl: () => null,
  TouchableOpacity: ({
    children,
    onPress,
    disabled,
    ...props
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  } & Record<string, unknown>) => {
    const { style: _s, activeOpacity: _ao, testID, ...rest } = props;
    return React.createElement(
      "button",
      {
        type: "button",
        onClick: onPress,
        disabled,
        ...(testID ? { "data-testid": testID } : {}),
        ...rest,
      },
      children,
    );
  },
  TextInput: ({
    placeholder,
    value,
    onChangeText,
    secureTextEntry,
    ...props
  }: {
    placeholder?: string;
    value?: string;
    onChangeText?: (text: string) => void;
    secureTextEntry?: boolean;
  } & Record<string, unknown>) => {
    const {
      style: _s,
      placeholderTextColor: _pc,
      keyboardType: _kt,
      autoCapitalize: _ac,
      autoCorrect: _acr,
      ...rest
    } = props;
    return React.createElement("input", {
      type: secureTextEntry ? "password" : "text",
      placeholder,
      value: value ?? "",
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(e.target.value),
      ...rest,
    });
  },
  Modal: ({
    children,
    visible,
    ...props
  }: {
    children?: React.ReactNode;
    visible?: boolean;
  } & Record<string, unknown>) => {
    if (!visible) return null;
    const { animationType: _at, transparent: _t, ...rest } = props;
    return React.createElement("div", { role: "dialog", ...rest }, children);
  },
  Image: ({
    source: _source,
    style: _style,
    accessibilityElementsHidden: _aeh,
    ...props
  }: Record<string, unknown>) => React.createElement("img", props),
  ActivityIndicator: () => React.createElement("span", null, "Loading..."),
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles,
    hairlineWidth: 1,
  },
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useLocalSearchParams: (...args: unknown[]) => mockUseLocalSearchParams(...args),
}));

vi.mock("../../theme", () => ({
  colors: {
    background: "#000",
    surface: "#1a1a1a",
    surfaceSecondary: "#2a2a2a",
    accent: "#0af",
    text: "#fff",
    textSecondary: "#999",
    textTertiary: "#666",
    danger: "#f00",
    positive: "#0f0",
    warning: "#ff0",
    teal: "#0ff",
    purple: "#a0f",
    blue: "#00f",
    green: "#0f0",
    orange: "#f80",
  },
}));

vi.mock("../../lib/auth-context", () => ({
  useAuth: () => ({
    serverUrl: "https://test.example.com",
    sessionToken: "test-token",
  }),
}));

const mockFileDelete = vi.fn();
vi.mock("expo-file-system", () => ({
  File: class MockFile {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get exists() {
      return true;
    }
    async text() {
      return "Date,Workout Name,Duration,Exercise Name\n2026-03-10,Leg Day,00:45:00,Squat";
    }
    async bytes() {
      return new TextEncoder().encode(
        "Date,Workout Name,Duration,Exercise Name\n2026-03-10,Leg Day,00:45:00,Squat",
      );
    }
    delete() {
      mockFileDelete(this.uri);
    }
    get type() {
      return "text/csv";
    }
    get size() {
      return 78;
    }
  },
}));

vi.mock("expo-web-browser", () => ({
  openBrowserAsync: vi.fn().mockResolvedValue({ type: "cancel" }),
}));

vi.mock("../../lib/share-import", () => ({
  importSharedFile: (...args: unknown[]) => mockImportSharedFile(...args),
}));

vi.mock("../../lib/telemetry", () => ({
  captureException: vi.fn(),
}));

const mockIsHealthKitAvailable = vi.fn().mockReturnValue(true);
const mockGetRequestStatus = vi.fn().mockResolvedValue("unnecessary");
const mockRequestPermissions = vi.fn().mockResolvedValue(true);

vi.mock("../../modules/health-kit", () => ({
  isAvailable: () => mockIsHealthKitAvailable(),
  getRequestStatus: (...args: unknown[]) => mockGetRequestStatus(...args),
  requestPermissions: (...args: unknown[]) => mockRequestPermissions(...args),
  queryDailyStatistics: vi.fn().mockResolvedValue([]),
  queryQuantitySamples: vi.fn().mockResolvedValue([]),
  queryWorkouts: vi.fn().mockResolvedValue([]),
  querySleepSamples: vi.fn().mockResolvedValue([]),
  queryWorkoutRoutes: vi.fn().mockResolvedValue([]),
}));

const mockSyncHealthKit = vi.fn().mockResolvedValue({ inserted: 0, errors: [] });

vi.mock("../../lib/health-kit-sync", () => ({
  syncHealthKitToServer: (...args: unknown[]) => mockSyncHealthKit(...args),
}));

vi.mock("@dofek/format/format", () => ({
  formatRelativeTime: (date: string) => `${date} ago`,
}));

const mockProvidersQuery = vi.fn();
const mockStatsQuery = vi.fn();
const mockLogsQuery = vi.fn();
const mockActiveSyncsQuery = vi.fn();
const mockInvalidate = vi.fn();
const mockSyncStatusFetch = vi.fn();
const mockCredentialSignIn = vi.fn();
const mockGarminSignIn = vi.fn();
const mockWhoopSignIn = vi.fn();
const mockWhoopVerifyCode = vi.fn();
const mockWhoopSaveTokens = vi.fn();

vi.mock("../../lib/trpc", () => ({
  trpc: {
    sync: {
      providers: { useQuery: (...args: unknown[]) => mockProvidersQuery(...args) },
      providerStats: { useQuery: (...args: unknown[]) => mockStatsQuery(...args) },
      logs: { useQuery: (...args: unknown[]) => mockLogsQuery(...args) },
      triggerSync: { useMutation: () => ({ mutateAsync: mockSyncMutateAsync }) },
      activeSyncs: { useQuery: (...args: unknown[]) => mockActiveSyncsQuery(...args) },
    },
    credentialAuth: {
      signIn: { useMutation: () => ({ mutateAsync: mockCredentialSignIn }) },
    },
    garminAuth: {
      signIn: { useMutation: () => ({ mutateAsync: mockGarminSignIn }) },
    },
    whoopAuth: {
      signIn: { useMutation: () => ({ mutateAsync: mockWhoopSignIn }) },
      verifyCode: { useMutation: () => ({ mutateAsync: mockWhoopVerifyCode }) },
      saveTokens: { useMutation: () => ({ mutateAsync: mockWhoopSaveTokens }) },
    },
    useUtils: () => ({
      invalidate: mockInvalidate,
      client: {
        healthKitSync: {
          pushQuantitySamples: { mutate: vi.fn().mockResolvedValue({ inserted: 0, errors: [] }) },
          pushWorkouts: { mutate: vi.fn().mockResolvedValue({ inserted: 0 }) },
          pushWorkoutRoutes: { mutate: vi.fn().mockResolvedValue({ inserted: 0 }) },
          pushSleepSamples: { mutate: vi.fn().mockResolvedValue({ inserted: 0 }) },
        },
      },
      sync: {
        providers: { invalidate: mockInvalidate },
        providerStats: { invalidate: mockInvalidate },
        logs: { invalidate: mockInvalidate },
        syncStatus: { fetch: mockSyncStatusFetch },
      },
    }),
  },
}));

const connectedProvider = {
  id: "wahoo",
  name: "Wahoo",
  authType: "oauth",
  authorized: true,
  importOnly: false,
  lastSyncedAt: "2026-03-19T12:00:00Z",
};

const disconnectedProvider = {
  id: "strava",
  name: "Strava",
  authType: "oauth",
  authorized: false,
  importOnly: false,
  lastSyncedAt: null,
};

const credentialProvider = {
  id: "eight-sleep",
  name: "Eight Sleep",
  authType: "credential",
  authorized: false,
  importOnly: false,
  lastSyncedAt: null,
};

const importOnlyProvider = {
  id: "strong-csv",
  name: "Strong",
  authType: "none",
  authorized: true,
  importOnly: true,
  lastSyncedAt: null,
};

function setupDefaultMocks() {
  mockProvidersQuery.mockReturnValue({
    data: [connectedProvider, disconnectedProvider],
    isLoading: false,
  });
  mockStatsQuery.mockReturnValue({ data: [], isLoading: false });
  mockLogsQuery.mockReturnValue({ data: [], isLoading: false });
  mockActiveSyncsQuery.mockReturnValue({ data: [] });
}

function makeProvider(
  overrides: Partial<{
    id: string;
    label: string;
    enabled: boolean;
    authStatus: "connected" | "not_connected" | "expired";
    authType: string;
    lastSyncAt: string | null;
    importOnly: boolean;
  }> = {},
) {
  return {
    id: overrides.id ?? "wahoo",
    label: overrides.label ?? "Wahoo",
    enabled: overrides.enabled ?? true,
    authStatus: overrides.authStatus ?? "connected",
    authType: overrides.authType ?? "oauth",
    lastSyncAt: overrides.lastSyncAt ?? null,
    importOnly: overrides.importOnly ?? false,
    ...overrides,
  };
}

const noopFn = () => {};

describe("providerActionLabel", () => {
  it("returns Sync for connected providers", () => {
    expect(providerActionLabel("connected")).toBe("Sync");
  });

  it("returns Connect for disconnected providers", () => {
    expect(providerActionLabel("not_connected")).toBe("Connect");
  });

  it("returns Connect for expired providers", () => {
    expect(providerActionLabel("expired")).toBe("Connect");
  });
});

describe("ProviderCard", () => {
  describe("sync progress", () => {
    it("renders progress bar when syncing with percentage", async () => {
      const { ProviderCard } = await import("./provider-card.tsx");
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ percentage: 45, message: "Fetching activities..." }}
          onSync={noopFn}
          onFullSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Fetching activities...")).toBeTruthy();
      expect(screen.queryByText("Connected")).toBeNull();
      expect(screen.queryByText("Never synced")).toBeNull();
    });

    it("renders progress message without percentage", async () => {
      const { ProviderCard } = await import("./provider-card.tsx");
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ message: "Preparing sync..." }}
          onSync={noopFn}
          onFullSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Preparing sync...")).toBeTruthy();
    });

    it("renders progress bar without message when only percentage is provided", async () => {
      const { ProviderCard } = await import("./provider-card.tsx");
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ percentage: 60 }}
          onSync={noopFn}
          onFullSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.queryByText("Connected")).toBeNull();
      expect(screen.queryByText("Never synced")).toBeNull();
    });
  });

  describe("normal metadata when not syncing", () => {
    it("renders auth status and last sync time when not syncing", async () => {
      const { ProviderCard } = await import("./provider-card.tsx");
      render(
        <ProviderCard
          provider={makeProvider({ lastSyncAt: "2026-03-19T12:00:00Z" })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onFullSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByText(/Last sync:/)).toBeTruthy();
    });

    it("renders 'Never synced' when provider has no lastSyncAt", async () => {
      const { ProviderCard } = await import("./provider-card.tsx");
      render(
        <ProviderCard
          provider={makeProvider({ lastSyncAt: null })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onFullSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByText("Never synced")).toBeTruthy();
    });

    it("renders normal metadata when syncing but syncProgress is undefined", async () => {
      const { ProviderCard } = await import("./provider-card.tsx");
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={undefined}
          onSync={noopFn}
          onFullSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByText("Never synced")).toBeTruthy();
    });

    it("renders 'Not connected' status for disconnected providers", async () => {
      const { ProviderCard } = await import("./provider-card.tsx");
      render(
        <ProviderCard
          provider={makeProvider({ authStatus: "not_connected" })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onFullSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Not connected")).toBeTruthy();
    });

    it("renders 'Expired' status for expired providers", async () => {
      const { ProviderCard } = await import("./provider-card.tsx");
      render(
        <ProviderCard
          provider={makeProvider({ authStatus: "expired" })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onFullSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Expired")).toBeTruthy();
    });
  });

  describe("progress percentage clamping", () => {
    it("renders without error when percentage is negative", async () => {
      const { ProviderCard } = await import("./provider-card.tsx");
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ percentage: -20 }}
          onSync={noopFn}
          onFullSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      // Should render the progress container, not the metadata
      expect(screen.queryByText("Connected")).toBeNull();
    });

    it("renders without error when percentage exceeds 100", async () => {
      const { ProviderCard } = await import("./provider-card.tsx");
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ percentage: 150 }}
          onSync={noopFn}
          onFullSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.queryByText("Connected")).toBeNull();
    });
  });

  it("renders provider label", async () => {
    const { ProviderCard } = await import("./provider-card.tsx");
    render(
      <ProviderCard
        provider={makeProvider({ label: "Wahoo" })}
        stats={undefined}
        syncing={false}
        syncProgress={undefined}
        onSync={noopFn}
        onFullSync={noopFn}
        onPress={noopFn}
      />,
    );

    expect(screen.getByText("Wahoo")).toBeTruthy();
  });

  describe("import-only providers", () => {
    it("does not render Sync button for import-only providers", async () => {
      const { ProviderCard } = await import("./provider-card.tsx");
      render(
        <ProviderCard
          provider={makeProvider({ importOnly: true, authStatus: "connected" })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onFullSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.queryByText("Sync")).toBeNull();
      expect(screen.queryByText("Connect")).toBeNull();
    });

    it("does not render Full sync link for import-only providers", async () => {
      const { ProviderCard } = await import("./provider-card.tsx");
      render(
        <ProviderCard
          provider={makeProvider({ importOnly: true, authStatus: "connected" })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onFullSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.queryByText("Full sync")).toBeNull();
    });

    it("shows 'Import only' instead of connection status", async () => {
      const { ProviderCard } = await import("./provider-card.tsx");
      render(
        <ProviderCard
          provider={makeProvider({ importOnly: true, authStatus: "connected" })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onFullSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Import only")).toBeTruthy();
      expect(screen.queryByText("Connected")).toBeNull();
      expect(screen.queryByText("Never synced")).toBeNull();
    });
  });
});

describe("ProvidersScreen", () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockReplace.mockReset();
    mockUseLocalSearchParams.mockReturnValue({});
    mockSyncMutateAsync.mockReset();
    mockImportSharedFile.mockReset();
    mockProvidersQuery.mockReset();
    mockStatsQuery.mockReset();
    mockLogsQuery.mockReset();
    mockActiveSyncsQuery.mockReset();
    mockInvalidate.mockReset();
    mockSyncStatusFetch.mockReset();
    mockCredentialSignIn.mockReset();
    mockGarminSignIn.mockReset();
    mockWhoopSignIn.mockReset();
    mockWhoopVerifyCode.mockReset();
    mockWhoopSaveTokens.mockReset();
    mockIsHealthKitAvailable.mockReset().mockReturnValue(true);
    mockGetRequestStatus.mockReset().mockResolvedValue("unnecessary");
    mockRequestPermissions.mockReset().mockResolvedValue(true);
    mockSyncHealthKit.mockReset().mockResolvedValue({ inserted: 0, errors: [] });
    setupDefaultMocks();
  });

  it("renders Full sync link for connected providers", async () => {
    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    await waitFor(() => {
      const wahooCard = within(screen.getByTestId("provider-card-wahoo"));
      expect(wahooCard.getByText("Full sync")).toBeTruthy();
    });
  });

  it("does not render Full sync link for disconnected providers", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [disconnectedProvider],
      isLoading: false,
    });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    const stravaCard = within(screen.getByTestId("provider-card-strava"));
    expect(stravaCard.queryByText("Full sync")).toBeNull();
  });

  it("renders Full Sync All button alongside Sync All", async () => {
    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    expect(screen.getByText("Sync All")).toBeTruthy();
    expect(screen.getByText("Full Sync All")).toBeTruthy();
  });

  it("passes sinceDays: 7 when Sync button is clicked", async () => {
    mockSyncMutateAsync.mockResolvedValue({ jobId: "job-1" });
    mockSyncStatusFetch.mockResolvedValue({
      status: "done",
      providers: { wahoo: { status: "done" } },
    });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    const wahooCard = within(screen.getByTestId("provider-card-wahoo"));
    fireEvent.click(wahooCard.getByText("Sync"));

    await waitFor(() => {
      expect(mockSyncMutateAsync).toHaveBeenCalledWith({
        providerId: "wahoo",
        sinceDays: 7,
      });
    });
  });

  it("passes sinceDays: undefined when Full sync link is clicked", async () => {
    mockSyncMutateAsync.mockResolvedValue({ jobId: "job-2" });
    mockSyncStatusFetch.mockResolvedValue({
      status: "done",
      providers: { wahoo: { status: "done" } },
    });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    const wahooCard = within(screen.getByTestId("provider-card-wahoo"));
    fireEvent.click(wahooCard.getByText("Full sync"));

    await waitFor(() => {
      expect(mockSyncMutateAsync).toHaveBeenCalledWith({
        providerId: "wahoo",
        sinceDays: undefined,
      });
    });
  });

  it("passes sinceDays: 7 when Sync All is clicked", async () => {
    mockSyncMutateAsync.mockResolvedValue({ jobId: "job-3", providerJobs: [] });
    mockSyncStatusFetch.mockResolvedValue({
      status: "done",
      providers: { wahoo: { status: "done" } },
    });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    fireEvent.click(screen.getByText("Sync All"));

    await waitFor(() => {
      expect(mockSyncMutateAsync).toHaveBeenCalledWith({ sinceDays: 7 });
    });
  });

  it("passes sinceDays: undefined when Full Sync All is clicked", async () => {
    mockSyncMutateAsync.mockResolvedValue({ jobId: "job-4", providerJobs: [] });
    mockSyncStatusFetch.mockResolvedValue({
      status: "done",
      providers: { wahoo: { status: "done" } },
    });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    fireEvent.click(screen.getByText("Full Sync All"));

    await waitFor(() => {
      expect(mockSyncMutateAsync).toHaveBeenCalledWith({ sinceDays: undefined });
    });
  });

  it("opens credential auth modal when Connect is clicked on a credential provider", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [credentialProvider],
      isLoading: false,
    });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    const eightSleepCard = within(screen.getByTestId("provider-card-eight-sleep"));
    fireEvent.click(eightSleepCard.getByText("Connect"));

    await waitFor(() => {
      expect(screen.getByText("Connect Eight Sleep")).toBeTruthy();
    });
  });

  it("credential auth modal calls signIn mutation with correct args", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [credentialProvider],
      isLoading: false,
    });
    mockCredentialSignIn.mockResolvedValue({});

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    // Open the modal
    const eightSleepCard = within(screen.getByTestId("provider-card-eight-sleep"));
    fireEvent.click(eightSleepCard.getByText("Connect"));
    await waitFor(() => {
      expect(screen.getByText("Connect Eight Sleep")).toBeTruthy();
    });

    // Fill in credentials
    fireEvent.change(screen.getByPlaceholderText("Email"), { target: { value: "user@test.com" } });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "secret123" } });

    // Submit
    fireEvent.click(screen.getByText("Sign In"));

    await waitFor(() => {
      expect(mockCredentialSignIn).toHaveBeenCalledWith({
        providerId: "eight-sleep",
        username: "user@test.com",
        password: "secret123",
      });
    });
  });

  it("calls importSharedFile when sharedFile param is present", async () => {
    mockImportSharedFile.mockResolvedValue({ providerId: "strong-csv", jobId: "job-share" });
    mockUseLocalSearchParams.mockReturnValue({
      sharedFile: "file:///tmp/Strong%20Export.csv",
    });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    await waitFor(() => {
      expect(mockImportSharedFile).toHaveBeenCalledWith(
        expect.objectContaining({
          fileUri: "file:///tmp/Strong%20Export.csv",
          serverUrl: "https://test.example.com",
          sessionToken: "test-token",
        }),
        expect.objectContaining({
          readBlob: expect.any(Function),
        }),
      );
    });
  });

  it("does not call router.replace before import completes", async () => {
    let resolveImport!: (value: unknown) => void;
    mockImportSharedFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve;
        }),
    );
    mockUseLocalSearchParams.mockReturnValue({
      sharedFile: "file:///tmp/Strong%20Export.csv",
    });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    await waitFor(() => {
      expect(mockImportSharedFile).toHaveBeenCalled();
    });

    // router.replace should NOT be called while import is still in progress
    expect(mockReplace).not.toHaveBeenCalled();

    // Clean up: resolve the pending import
    resolveImport({ providerId: "strong-csv", jobId: "job-1" });
  });

  it("does not render Sync or Full sync for import-only providers", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [importOnlyProvider],
      isLoading: false,
    });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    const strongCard = within(screen.getByTestId("provider-card-strong-csv"));
    expect(strongCard.getByText("Strong")).toBeTruthy();
    expect(strongCard.getByText("Import only")).toBeTruthy();
    expect(strongCard.queryByText("Sync")).toBeNull();
    expect(strongCard.queryByText("Full sync")).toBeNull();
  });

  it("excludes import-only providers from Sync All", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [importOnlyProvider],
      isLoading: false,
    });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    // Sync All button should not appear when only import-only providers exist
    expect(screen.queryByText("Sync All")).toBeNull();
  });

  it("passes readBlob that returns a standard Blob with file data", async () => {
    mockImportSharedFile.mockResolvedValue({ providerId: "strong-csv", jobId: "job-share" });
    mockUseLocalSearchParams.mockReturnValue({
      sharedFile: "file:///tmp/strong.csv",
    });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    await waitFor(() => {
      expect(mockImportSharedFile).toHaveBeenCalled();
    });

    const callArgs = mockImportSharedFile.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.[1]).toHaveProperty("readBlob");
    const readBlob: (uri: string) => Promise<Blob> = callArgs[1].readBlob;
    const blob = await readBlob("file:///tmp/strong.csv");

    // Must be a real Blob, not a raw ExpoFile reference
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
    const text = await blob.text();
    expect(text).toContain("Workout Name");

    // Should clean up the Inbox copy after reading
    expect(mockFileDelete).toHaveBeenCalledWith("file:///tmp/strong.csv");
  });

  it("shows Expired status when provider needsReauth", async () => {
    const expiredProvider = {
      ...connectedProvider,
      id: "polar",
      name: "Polar",
      needsReauth: true,
    };
    mockProvidersQuery.mockReturnValue({
      data: [expiredProvider],
      isLoading: false,
    });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    const polarCard = within(screen.getByTestId("provider-card-polar"));
    expect(polarCard.getByText("Expired")).toBeTruthy();
    expect(polarCard.getByText("Connect")).toBeTruthy();
  });

  it("opens browser for OAuth provider connect", async () => {
    const WebBrowser = await import("expo-web-browser");
    mockProvidersQuery.mockReturnValue({
      data: [disconnectedProvider],
      isLoading: false,
    });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    const stravaCard = within(screen.getByTestId("provider-card-strava"));
    fireEvent.click(stravaCard.getByText("Connect"));

    await waitFor(() => {
      expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(
        "https://test.example.com/auth/provider/strava?session=test-token",
      );
    });
  });

  it("opens Garmin auth modal when Connect is clicked on a custom:garmin provider", async () => {
    const garminProvider = {
      id: "garmin",
      name: "Garmin",
      authType: "custom:garmin",
      authorized: false,
      importOnly: false,
      lastSyncedAt: null,
    };
    mockProvidersQuery.mockReturnValue({
      data: [garminProvider],
      isLoading: false,
    });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    const garminCard = within(screen.getByTestId("provider-card-garmin"));
    fireEvent.click(garminCard.getByText("Connect"));

    await waitFor(() => {
      expect(screen.getByText("Connect Garmin")).toBeTruthy();
    });
  });

  it("Garmin auth modal calls signIn mutation with correct args", async () => {
    const garminProvider = {
      id: "garmin",
      name: "Garmin",
      authType: "custom:garmin",
      authorized: false,
      importOnly: false,
      lastSyncedAt: null,
    };
    mockProvidersQuery.mockReturnValue({
      data: [garminProvider],
      isLoading: false,
    });
    mockGarminSignIn.mockResolvedValue({ success: true });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    const garminCard = within(screen.getByTestId("provider-card-garmin"));
    fireEvent.click(garminCard.getByText("Connect"));
    await waitFor(() => {
      expect(screen.getByText("Connect Garmin")).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText("Email"), {
      target: { value: "user@garmin.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "garminpass" } });
    fireEvent.click(screen.getByText("Sign In"));

    await waitFor(() => {
      expect(mockGarminSignIn).toHaveBeenCalledWith({
        username: "user@garmin.com",
        password: "garminpass",
      });
    });
  });

  it("opens WHOOP auth modal when Connect is clicked on a custom:whoop provider", async () => {
    const whoopProvider = {
      id: "whoop",
      name: "WHOOP",
      authType: "custom:whoop",
      authorized: false,
      importOnly: false,
      lastSyncedAt: null,
    };
    mockProvidersQuery.mockReturnValue({
      data: [whoopProvider],
      isLoading: false,
    });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    const whoopCard = within(screen.getByTestId("provider-card-whoop"));
    fireEvent.click(whoopCard.getByText("Connect"));

    await waitFor(() => {
      expect(screen.getByText("Connect WHOOP")).toBeTruthy();
    });
  });

  it("WHOOP auth modal handles direct sign-in without MFA", async () => {
    const whoopProvider = {
      id: "whoop",
      name: "WHOOP",
      authType: "custom:whoop",
      authorized: false,
      importOnly: false,
      lastSyncedAt: null,
    };
    mockProvidersQuery.mockReturnValue({
      data: [whoopProvider],
      isLoading: false,
    });
    mockWhoopSignIn.mockResolvedValue({
      status: "success",
      token: { accessToken: "at", refreshToken: "rt", userId: 123 },
    });
    mockWhoopSaveTokens.mockResolvedValue({ success: true });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    const whoopCard = within(screen.getByTestId("provider-card-whoop"));
    fireEvent.click(whoopCard.getByText("Connect"));
    await waitFor(() => {
      expect(screen.getByText("Connect WHOOP")).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText("Email"), { target: { value: "user@whoop.com" } });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "whooppass" } });
    fireEvent.click(screen.getByText("Sign In"));

    await waitFor(() => {
      expect(mockWhoopSignIn).toHaveBeenCalledWith({
        username: "user@whoop.com",
        password: "whooppass",
      });
      expect(mockWhoopSaveTokens).toHaveBeenCalledWith({
        accessToken: "at",
        refreshToken: "rt",
        userId: 123,
      });
    });
  });

  it("WHOOP auth modal handles MFA verification flow", async () => {
    const whoopProvider = {
      id: "whoop",
      name: "WHOOP",
      authType: "custom:whoop",
      authorized: false,
      importOnly: false,
      lastSyncedAt: null,
    };
    mockProvidersQuery.mockReturnValue({
      data: [whoopProvider],
      isLoading: false,
    });
    mockWhoopSignIn.mockResolvedValue({
      status: "verification_required",
      challengeId: "challenge-123",
      method: "sms",
    });
    mockWhoopVerifyCode.mockResolvedValue({
      status: "success",
      token: { accessToken: "at2", refreshToken: "rt2", userId: 456 },
    });
    mockWhoopSaveTokens.mockResolvedValue({ success: true });

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    // Open modal and sign in
    const whoopCard = within(screen.getByTestId("provider-card-whoop"));
    fireEvent.click(whoopCard.getByText("Connect"));
    await waitFor(() => {
      expect(screen.getByText("Connect WHOOP")).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText("Email"), { target: { value: "user@whoop.com" } });
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "whooppass" } });
    fireEvent.click(screen.getByText("Sign In"));

    // Should show verification step
    await waitFor(() => {
      expect(screen.getByText("Verify Code")).toBeTruthy();
      expect(screen.getByPlaceholderText("Verification code")).toBeTruthy();
    });

    // Enter code and verify
    fireEvent.change(screen.getByPlaceholderText("Verification code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByText("Verify"));

    await waitFor(() => {
      expect(mockWhoopVerifyCode).toHaveBeenCalledWith({
        challengeId: "challenge-123",
        code: "123456",
      });
      expect(mockWhoopSaveTokens).toHaveBeenCalledWith({
        accessToken: "at2",
        refreshToken: "rt2",
        userId: 456,
      });
    });
  });

  it("renders Apple Health as import-only when HealthKit is not available", async () => {
    mockIsHealthKitAvailable.mockReturnValue(false);

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    const appleCard = within(screen.getByTestId("provider-card-apple_health"));
    expect(appleCard.getByText("Apple Health")).toBeTruthy();
    expect(appleCard.getByText("Import only")).toBeTruthy();
    expect(appleCard.queryByText("Sync")).toBeNull();
    expect(appleCard.queryByText("Connect")).toBeNull();
  });

  it("renders Apple Health card when HealthKit is available", async () => {
    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    expect(screen.getByTestId("provider-card-apple_health")).toBeTruthy();
    expect(screen.getByText("Apple Health")).toBeTruthy();
  });

  it("triggers HealthKit sync with syncRangeDays: 7 when Sync is clicked", async () => {
    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    // Wait for async permission check to resolve (connected state)
    await waitFor(() => {
      const appleCard = within(screen.getByTestId("provider-card-apple_health"));
      expect(appleCard.getByText("Sync")).toBeTruthy();
    });

    const appleCard = within(screen.getByTestId("provider-card-apple_health"));
    fireEvent.click(appleCard.getByText("Sync"));

    await waitFor(() => {
      expect(mockSyncHealthKit).toHaveBeenCalledWith(expect.objectContaining({ syncRangeDays: 7 }));
    });
  });

  it("triggers HealthKit sync with syncRangeDays: null when Full sync is clicked", async () => {
    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    // Wait for async permission check to resolve (connected state)
    await waitFor(() => {
      const appleCard = within(screen.getByTestId("provider-card-apple_health"));
      expect(appleCard.getByText("Full sync")).toBeTruthy();
    });

    const appleCard = within(screen.getByTestId("provider-card-apple_health"));
    fireEvent.click(appleCard.getByText("Full sync"));

    await waitFor(() => {
      expect(mockSyncHealthKit).toHaveBeenCalledWith(
        expect.objectContaining({ syncRangeDays: null }),
      );
    });
  });

  it("shows Connect button when HealthKit permissions not granted", async () => {
    mockGetRequestStatus.mockResolvedValue("shouldRequest");

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    await waitFor(() => {
      const appleCard = within(screen.getByTestId("provider-card-apple_health"));
      expect(appleCard.getByText("Connect")).toBeTruthy();
    });
  });

  it("calls requestPermissions when Connect is clicked on Apple Health", async () => {
    mockGetRequestStatus.mockResolvedValue("shouldRequest");

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    await waitFor(() => {
      const appleCard = within(screen.getByTestId("provider-card-apple_health"));
      expect(appleCard.getByText("Connect")).toBeTruthy();
    });

    const appleCard = within(screen.getByTestId("provider-card-apple_health"));
    fireEvent.click(appleCard.getByText("Connect"));

    await waitFor(() => {
      expect(mockRequestPermissions).toHaveBeenCalled();
    });
  });

  it("reports error to Sentry when Apple Health connect fails", async () => {
    const { captureException } = await import("../../lib/telemetry");
    const mockCaptureException = vi.mocked(captureException);
    mockCaptureException.mockClear();

    const connectError = new Error("HealthKit authorization failed");
    mockGetRequestStatus.mockResolvedValue("shouldRequest");
    mockRequestPermissions.mockRejectedValue(connectError);

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    await waitFor(() => {
      const appleCard = within(screen.getByTestId("provider-card-apple_health"));
      expect(appleCard.getByText("Connect")).toBeTruthy();
    });

    const appleCard = within(screen.getByTestId("provider-card-apple_health"));
    fireEvent.click(appleCard.getByText("Connect"));

    await waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(connectError, {
        context: "healthkit-connect",
      });
    });
  });

  it("shows error message when Apple Health connect fails", async () => {
    mockGetRequestStatus.mockResolvedValue("shouldRequest");
    mockRequestPermissions.mockRejectedValue(new Error("Authorization denied"));

    const { default: ProvidersScreen } = await import("./index");
    render(<ProvidersScreen />);

    await waitFor(() => {
      const appleCard = within(screen.getByTestId("provider-card-apple_health"));
      expect(appleCard.getByText("Connect")).toBeTruthy();
    });

    const appleCard = within(screen.getByTestId("provider-card-apple_health"));
    fireEvent.click(appleCard.getByText("Connect"));

    await waitFor(() => {
      expect(screen.getByText("Authorization denied")).toBeTruthy();
    });
  });
});
