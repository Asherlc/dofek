// @vitest-environment jsdom

import { ROUTINE_SYNC_DAYS } from "@dofek/providers/sync-actions";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerActionLabel } from "../../app/providers/provider-card";

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockUseLocalSearchParams = vi.fn().mockReturnValue({});
const mockSyncMutateAsync = vi.fn();
const mockImportSharedFile = vi.fn();
const mockGetDocumentAsync = vi.fn();
const mockAlert = vi.hoisted(() => vi.fn());
const mockSendAccessibilityEvent = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: vi.fn() }),
  },
  View: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => {
    const {
      style,
      contentContainerStyle: _cs,
      activeOpacity: _ao,
      numberOfLines: _nl,
      testID,
      ...rest
    } = props;
    return React.createElement(
      "div",
      {
        ...(testID ? { "data-testid": testID } : {}),
        ...(testID && style ? { "data-style": JSON.stringify(style) } : {}),
        ...rest,
      },
      children,
    );
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
  Alert: { alert: mockAlert },
  TouchableOpacity: React.forwardRef(
    (
      {
        children,
        onPress,
        disabled,
        ...props
      }: {
        children?: React.ReactNode;
        onPress?: () => void;
        disabled?: boolean;
      } & Record<string, unknown>,
      ref: React.ForwardedRef<HTMLButtonElement>,
    ) => {
      const {
        accessibilityLabel,
        accessibilityRole,
        accessibilityState,
        accessible,
        style: _s,
        activeOpacity: _ao,
        testID,
        ...rest
      } = props;
      const state =
        typeof accessibilityState === "object" && accessibilityState !== null
          ? accessibilityState
          : {};
      return React.createElement(
        "button",
        {
          type: "button",
          ref,
          onClick: onPress,
          disabled,
          "aria-busy": "busy" in state ? state.busy : undefined,
          "aria-disabled": "disabled" in state ? state.disabled : undefined,
          "aria-label": accessibilityLabel,
          "data-accessible": accessible,
          role: accessibilityRole ?? "presentation",
          ...(testID ? { "data-testid": testID } : {}),
          ...rest,
        },
        children,
      );
    },
  ),
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
    const { animationType: _at, transparent: _t, onRequestClose: _orc, onShow, ...rest } = props;
    React.useEffect(() => {
      if (visible) onShow?.();
    }, [onShow, visible]);
    return visible ? React.createElement("div", { role: "dialog", ...rest }, children) : null;
  },
  AccessibilityInfo: { sendAccessibilityEvent: mockSendAccessibilityEvent },
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
  radius: { xl: 16, lg: 12, md: 8, sm: 4, full: 9999 },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
}));

const mockAuthState = vi.hoisted((): { sessionToken: string | null } => ({
  sessionToken: "test-token",
}));

vi.mock("../../lib/auth-context", () => ({
  useAuth: () => ({
    serverUrl: "https://test.example.com",
    sessionToken: mockAuthState.sessionToken,
  }),
}));

const mockFileDelete = vi.fn();
const mockFileBytes = vi.fn(async () =>
  new TextEncoder().encode(
    "Date,Workout Name,Duration,Exercise Name\n2026-03-10,Leg Day,00:45:00,Squat",
  ),
);
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
      return mockFileBytes();
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

vi.mock("expo-document-picker", () => ({
  getDocumentAsync: (...args: unknown[]) => mockGetDocumentAsync(...args),
}));

vi.mock("../../lib/share-import", () => ({
  importSharedFile: (...args: unknown[]) => mockImportSharedFile(...args),
}));

vi.mock("../../lib/telemetry", () => ({
  captureException: vi.fn(),
}));

const mockIsHealthKitAvailable = vi.fn().mockReturnValue(true);
const mockGetRequestStatus = vi.fn().mockResolvedValue("unnecessary");
const mockHasEverAuthorized = vi.fn().mockReturnValue(true);
const mockRequestPermissions = vi.fn().mockResolvedValue(true);

vi.mock("../../modules/health-kit", () => ({
  isAvailable: () => mockIsHealthKitAvailable(),
  getRequestStatus: (...args: unknown[]) => mockGetRequestStatus(...args),
  hasEverAuthorized: (...args: unknown[]) => mockHasEverAuthorized(...args),
  requestPermissions: (...args: unknown[]) => mockRequestPermissions(...args),
  completeAnchoredQuery: vi.fn().mockResolvedValue(true),
  queryAnchoredSamples: vi.fn().mockResolvedValue({
    queryId: null,
    samples: [],
    deletedUUIDs: [],
  }),
  queryDailyStatistics: vi.fn().mockResolvedValue([]),
  queryQuantitySamples: vi.fn().mockResolvedValue([]),
  queryWorkouts: vi.fn().mockResolvedValue([]),
  querySleepSamples: vi.fn().mockResolvedValue([]),
  queryWorkoutRoutes: vi.fn().mockResolvedValue([]),
  writeDietarySamples: vi.fn().mockResolvedValue(true),
  deleteDietarySamples: vi.fn().mockResolvedValue(0),
}));

const mockSyncHealthKit = vi.fn().mockResolvedValue({ inserted: 0, errors: [] });

vi.mock("../../lib/health-kit-sync", () => ({
  syncHealthKitToServer: (...args: unknown[]) => mockSyncHealthKit(...args),
}));

const mockSyncDofekFoodToHealthKit = vi.fn().mockResolvedValue({
  written: 0,
  skipped: 0,
  errors: [],
});

vi.mock("../../lib/health-kit-food-writeback", () => ({
  syncDofekFoodToHealthKit: (...args: unknown[]) => mockSyncDofekFoodToHealthKit(...args),
}));

vi.mock("@dofek/format/format", () => ({
  formatDateYmd: (date?: Date) => (date ?? new Date()).toISOString().slice(0, 10),
  formatRelativeTime: (date: string) => `${date} ago`,
}));

const mockProvidersQuery = vi.fn();
const mockStatsQuery = vi.fn();
const mockLogsQuery = vi.fn();
const mockDataHealthQuery = vi.fn();
const mockActiveSyncsQuery = vi.fn();
const mockActiveImportsQuery = vi.fn();
const mockInvalidate = vi.fn();
const mockInvalidateProviders = vi.fn();
const mockInvalidateProviderStats = vi.fn();
const mockInvalidateLogs = vi.fn();
const mockInvalidateDataHealth = vi.fn();
const mockInvalidateActiveSyncs = vi.fn();
const mockInvalidateActiveImports = vi.fn();
const mockSyncStatusFetch = vi.fn();
const mockCredentialSignIn = vi.fn();
const mockTokenConnect = vi.fn();
const mockGarminSignIn = vi.fn();
const mockWhoopSignIn = vi.fn();
const mockWhoopVerifyCode = vi.fn();
const mockWhoopSaveTokens = vi.fn();
const mockUseRefresh = vi.fn((_options: { invalidate?: () => Promise<void> } | undefined) => ({
  refreshing: false,
  onRefresh: vi.fn(),
}));

vi.mock("../../lib/useRefresh", () => ({
  useRefresh: (options: { invalidate?: () => Promise<void> } | undefined) =>
    mockUseRefresh(options),
}));

vi.mock("../../lib/trpc", () => ({
  trpc: {
    processing: {
      status: { useQuery: (...args: unknown[]) => mockDataHealthQuery(...args) },
      dismiss: { useMutation: () => ({ error: null, isPending: false, mutate: vi.fn() }) },
    },
    sync: {
      providers: { useQuery: (...args: unknown[]) => mockProvidersQuery(...args) },
      providerStats: { useQuery: (...args: unknown[]) => mockStatsQuery(...args) },
      logs: { useQuery: (...args: unknown[]) => mockLogsQuery(...args) },
      triggerSync: { useMutation: () => ({ mutateAsync: mockSyncMutateAsync }) },
      activeSyncs: { useQuery: (...args: unknown[]) => mockActiveSyncsQuery(...args) },
      activeImports: { useQuery: (...args: unknown[]) => mockActiveImportsQuery(...args) },
    },
    credentialAuth: {
      signIn: { useMutation: () => ({ mutateAsync: mockCredentialSignIn }) },
    },
    tokenAuth: {
      connect: { useMutation: () => ({ mutateAsync: mockTokenConnect }) },
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
          deleteQuantitySamples: { mutate: vi.fn().mockResolvedValue({ deleted: 0 }) },
          pushQuantitySamples: { mutate: vi.fn().mockResolvedValue({ inserted: 0, errors: [] }) },
          pushWorkouts: { mutate: vi.fn().mockResolvedValue({ inserted: 0 }) },
          pushWorkoutRoutes: { mutate: vi.fn().mockResolvedValue({ inserted: 0 }) },
          pushSleepSamples: { mutate: vi.fn().mockResolvedValue({ inserted: 0 }) },
        },
        food: {
          healthKitWriteBackEntries: { query: vi.fn().mockResolvedValue([]) },
        },
      },
      processing: {
        status: { invalidate: mockInvalidateDataHealth },
      },
      sync: {
        providers: { invalidate: mockInvalidateProviders },
        providerStats: { invalidate: mockInvalidateProviderStats },
        logs: { invalidate: mockInvalidateLogs },
        activeSyncs: { invalidate: mockInvalidateActiveSyncs },
        activeImports: { invalidate: mockInvalidateActiveImports },
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

const tokenProvider = {
  id: "wger",
  name: "Wger",
  authType: "token",
  tokenAuth: {
    label: "JWT refresh token",
    instructionsUrl: "https://wger.readthedocs.io/en/latest/api/api.html#jwt-tokens",
  },
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

const pushOnlyProvider = {
  id: "apple-health",
  name: "Apple Health",
  authType: "none",
  authorized: true,
  importOnly: false,
  pushOnly: true,
  lastSyncedAt: null,
};

function setupDefaultMocks() {
  mockProvidersQuery.mockReturnValue({
    data: [connectedProvider, disconnectedProvider],
    isLoading: false,
    error: null,
  });
  mockStatsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
  mockLogsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
  mockDataHealthQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
  mockActiveSyncsQuery.mockReturnValue({ data: [] });
  mockActiveImportsQuery.mockReturnValue({ data: [], error: null });
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
    pushOnly: boolean;
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
    pushOnly: overrides.pushOnly ?? false,
    ...overrides,
  };
}

const noopFn = () => {};

async function renderProvidersScreen() {
  const { default: ProvidersScreen } = await import("../../app/providers/index");
  let rendered: ReturnType<typeof render> | undefined;

  await act(async () => {
    rendered = render(<ProvidersScreen />);
    await Promise.resolve();
  });

  if (!rendered) throw new Error("ProvidersScreen did not render");
  return rendered;
}

describe("providerActionLabel", () => {
  it("returns Sync for connected providers", () => {
    expect(providerActionLabel("connected")).toBe("Sync");
  });

  it("returns Connect for disconnected providers", () => {
    expect(providerActionLabel("not_connected")).toBe("Connect");
  });

  it("returns Reconnect for expired providers", () => {
    expect(providerActionLabel("expired")).toBe("Reconnect");
  });
});

describe("ProviderCard", () => {
  it("exposes one primary action and one details control", async () => {
    const { ProviderCard } = await import("../../app/providers/provider-card");
    render(
      <ProviderCard
        provider={makeProvider({ label: "Wahoo" })}
        stats={undefined}
        syncing={false}
        syncProgress={undefined}
        onSync={noopFn}
        onConnect={noopFn}
        onPress={noopFn}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Open Wahoo details" }).getAttribute("aria-label"),
    ).toBe("Open Wahoo details");
    expect(screen.getByRole("button", { name: "Sync Wahoo" }).getAttribute("aria-label")).toBe(
      "Sync Wahoo",
    );
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("announces a syncing provider action as busy and disabled", async () => {
    const { ProviderCard } = await import("../../app/providers/provider-card");
    render(
      <ProviderCard
        provider={makeProvider({ label: "Wahoo" })}
        stats={undefined}
        syncing
        syncProgress={{ message: "Syncing..." }}
        onSync={noopFn}
        onConnect={noopFn}
        onPress={noopFn}
      />,
    );

    const syncButton = screen.getByRole("button", { name: "Sync Wahoo" });
    expect(syncButton.getAttribute("aria-busy")).toBe("true");
    expect(syncButton.getAttribute("aria-disabled")).toBe("true");
  });

  it("does not nest action buttons inside the card detail button", async () => {
    const { ProviderCard } = await import("../../app/providers/provider-card");
    const { container } = render(
      <ProviderCard
        provider={makeProvider({ lastSyncAt: "2026-03-19T12:00:00Z" })}
        stats={undefined}
        syncing={false}
        syncProgress={undefined}
        onSync={noopFn}
        onConnect={noopFn}
        onPress={noopFn}
      />,
    );

    expect(container.querySelector("button button")).toBeNull();
  });

  describe("sync progress", () => {
    it("renders progress bar when syncing with percentage", async () => {
      const { ProviderCard } = await import("../../app/providers/provider-card");
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ percentage: 45, message: "Fetching activities..." }}
          onSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Fetching activities...")).toBeTruthy();
      expect(screen.queryByText("Connected")).toBeNull();
      expect(screen.queryByText("Never synced")).toBeNull();
    });

    it("renders progress message without percentage", async () => {
      const { ProviderCard } = await import("../../app/providers/provider-card");
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ message: "Preparing sync..." }}
          onSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Preparing sync...")).toBeTruthy();
    });

    it("renders progress bar without message when only percentage is provided", async () => {
      const { ProviderCard } = await import("../../app/providers/provider-card");
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ percentage: 60 }}
          onSync={noopFn}
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
      const { ProviderCard } = await import("../../app/providers/provider-card");
      render(
        <ProviderCard
          provider={makeProvider({ lastSyncAt: "2026-03-19T12:00:00Z" })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByText(/Last sync:/)).toBeTruthy();
    });

    it("renders 'Never synced' when provider has no lastSyncAt", async () => {
      const { ProviderCard } = await import("../../app/providers/provider-card");
      render(
        <ProviderCard
          provider={makeProvider({ lastSyncAt: null })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByText("Never synced")).toBeTruthy();
    });

    it("renders normal metadata when syncing but syncProgress is undefined", async () => {
      const { ProviderCard } = await import("../../app/providers/provider-card");
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={undefined}
          onSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByText("Never synced")).toBeTruthy();
    });

    it("renders 'Not connected' status for disconnected providers", async () => {
      const { ProviderCard } = await import("../../app/providers/provider-card");
      render(
        <ProviderCard
          provider={makeProvider({ authStatus: "not_connected" })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Not connected")).toBeTruthy();
    });

    it("renders 'Expired' status for expired providers", async () => {
      const { ProviderCard } = await import("../../app/providers/provider-card");
      render(
        <ProviderCard
          provider={makeProvider({ authStatus: "expired" })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Expired")).toBeTruthy();
    });
  });

  describe("progress percentage clamping", () => {
    it("renders without error when percentage is negative", async () => {
      const { ProviderCard } = await import("../../app/providers/provider-card");
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ percentage: -20 }}
          onSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      // Should render the progress container, not the metadata
      expect(screen.queryByText("Connected")).toBeNull();
    });

    it("renders without error when percentage exceeds 100", async () => {
      const { ProviderCard } = await import("../../app/providers/provider-card");
      render(
        <ProviderCard
          provider={makeProvider()}
          stats={undefined}
          syncing={true}
          syncProgress={{ percentage: 150 }}
          onSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.queryByText("Connected")).toBeNull();
    });
  });

  it("renders provider label", async () => {
    const { ProviderCard } = await import("../../app/providers/provider-card");
    render(
      <ProviderCard
        provider={makeProvider({ label: "Wahoo" })}
        stats={undefined}
        syncing={false}
        syncProgress={undefined}
        onSync={noopFn}
        onPress={noopFn}
      />,
    );

    expect(screen.getByText("Wahoo")).toBeTruthy();
  });

  it("renders the shared file import button alongside sync for providers that support both", async () => {
    const { ProviderCard } = await import("../../app/providers/provider-card");
    const importFile = vi.fn();
    render(
      <ProviderCard
        provider={makeProvider({ id: "apple_health", label: "Apple Health" })}
        stats={undefined}
        syncing={false}
        syncProgress={undefined}
        onSync={noopFn}
        onConnect={noopFn}
        onImport={importFile}
        onPress={noopFn}
      />,
    );

    expect(screen.getByText("Sync")).toBeTruthy();
    fireEvent.click(screen.getByText("Import file"));

    expect(importFile).toHaveBeenCalledOnce();
  });

  it("wires provider ids through the shared file import provider card", async () => {
    const { FileImportProviderCard } = await import(
      "../../app/providers/file-import-provider-card"
    );
    const importProvider = vi.fn();
    render(
      <FileImportProviderCard
        provider={makeProvider({ id: "apple_health", label: "Apple Health" })}
        stats={undefined}
        syncing={false}
        syncProgress={undefined}
        onSync={noopFn}
        onConnect={noopFn}
        onImportProvider={importProvider}
        onPress={noopFn}
      />,
    );

    fireEvent.click(screen.getByText("Import file"));

    expect(importProvider).toHaveBeenCalledWith("apple-health");
  });

  it("renders the shared provider summary on file import provider cards", async () => {
    const { FileImportProviderCard } = await import(
      "../../app/providers/file-import-provider-card"
    );
    render(
      <FileImportProviderCard
        provider={makeProvider({ id: "strong-csv", label: "Strong", importOnly: true })}
        stats={{
          totalRecords: 206_539,
          activities: 352,
          metricStream: 205_367,
          dailyMetrics: 229,
          sleepSessions: 155,
          bodyMeasurements: 43,
          healthEvents: 392,
          foodEntries: 0,
          nutritionDaily: 0,
          labPanels: 0,
          labResults: 0,
          journalEntries: 0,
        }}
        syncing={false}
        syncProgress={undefined}
        onSync={noopFn}
        onConnect={noopFn}
        onImportProvider={noopFn}
        onPress={noopFn}
      />,
    );

    expect(screen.getByText("206,539")).toBeTruthy();
    expect(screen.getByText("records")).toBeTruthy();
    expect(screen.getByText("Activities")).toBeTruthy();
    expect(screen.getByText("352")).toBeTruthy();
    expect(screen.getByText("Metric Stream")).toBeTruthy();
    expect(screen.getByText("205,367")).toBeTruthy();
    expect(screen.getByText("Daily Metrics")).toBeTruthy();
    expect(screen.getByText("229")).toBeTruthy();
    expect(screen.getByText("Sleep")).toBeTruthy();
    expect(screen.getByText("155")).toBeTruthy();
    expect(screen.getByText("Body")).toBeTruthy();
    expect(screen.getByText("43")).toBeTruthy();
    expect(screen.getByText("Events")).toBeTruthy();
    expect(screen.getByText("392")).toBeTruthy();
  });

  describe("import-only providers", () => {
    it("keeps the sync action separate from an active file import", async () => {
      const { ProviderCard } = await import("../../app/providers/provider-card");
      render(
        <ProviderCard
          provider={makeProvider({ importOnly: false, authStatus: "connected" })}
          stats={undefined}
          syncing={false}
          importing={true}
          syncProgress={{ percentage: 25, message: "Importing file" }}
          onSync={noopFn}
          onConnect={noopFn}
          onImport={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.getByText("Sync")).toBeTruthy();
      expect(screen.queryByText("Import file")).toBeNull();
      expect(screen.getByText("Importing file")).toBeTruthy();
    });

    it("does not render Sync button for import-only providers", async () => {
      const { ProviderCard } = await import("../../app/providers/provider-card");
      render(
        <ProviderCard
          provider={makeProvider({ importOnly: true, authStatus: "connected" })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
          onConnect={noopFn}
          onPress={noopFn}
        />,
      );

      expect(screen.queryByText("Sync")).toBeNull();
      expect(screen.queryByText("Connect")).toBeNull();
    });

    it("shows 'Import only' instead of connection status", async () => {
      const { ProviderCard } = await import("../../app/providers/provider-card");
      render(
        <ProviderCard
          provider={makeProvider({ importOnly: true, authStatus: "connected" })}
          stats={undefined}
          syncing={false}
          syncProgress={undefined}
          onSync={noopFn}
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
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: "provider-handoff-code" }), { status: 200 }),
        ),
    );
    mockPush.mockReset();
    mockReplace.mockReset();
    mockUseLocalSearchParams.mockReturnValue({});
    mockSyncMutateAsync.mockReset();
    mockImportSharedFile.mockReset();
    mockGetDocumentAsync.mockReset();
    mockAlert.mockReset();
    mockSendAccessibilityEvent.mockReset();
    mockProvidersQuery.mockReset();
    mockStatsQuery.mockReset();
    mockLogsQuery.mockReset();
    mockDataHealthQuery.mockReset();
    mockActiveSyncsQuery.mockReset();
    mockActiveImportsQuery.mockReset();
    mockInvalidate.mockReset();
    mockInvalidateProviders.mockReset();
    mockInvalidateProviderStats.mockReset();
    mockInvalidateLogs.mockReset();
    mockInvalidateDataHealth.mockReset();
    mockInvalidateActiveSyncs.mockReset();
    mockInvalidateActiveImports.mockReset();
    mockSyncStatusFetch.mockReset();
    mockUseRefresh.mockClear();
    mockCredentialSignIn.mockReset();
    mockTokenConnect.mockReset();
    mockGarminSignIn.mockReset();
    mockWhoopSignIn.mockReset();
    mockWhoopVerifyCode.mockReset();
    mockWhoopSaveTokens.mockReset();
    mockFileDelete.mockReset();
    mockAuthState.sessionToken = "test-token";
    mockFileBytes.mockClear();
    mockIsHealthKitAvailable.mockReset().mockReturnValue(true);
    mockGetRequestStatus.mockReset().mockResolvedValue("unnecessary");
    mockHasEverAuthorized.mockReset().mockReturnValue(true);
    mockRequestPermissions.mockReset().mockResolvedValue(true);
    mockSyncHealthKit.mockReset().mockResolvedValue({ inserted: 0, errors: [] });
    mockSyncDofekFoodToHealthKit.mockReset().mockResolvedValue({
      written: 0,
      skipped: 0,
      errors: [],
    });
    setupDefaultMocks();
  });

  it("scopes pull-to-refresh to provider list query families", async () => {
    await renderProvidersScreen();

    const refreshOptions = mockUseRefresh.mock.calls.at(-1)?.[0];
    await refreshOptions?.invalidate?.();

    expect(mockInvalidateProviders).toHaveBeenCalled();
    expect(mockInvalidateProviderStats).toHaveBeenCalled();
    expect(mockInvalidateLogs).toHaveBeenCalledWith({ limit: 50 });
    expect(mockInvalidateDataHealth).toHaveBeenCalled();
    expect(mockInvalidateActiveSyncs).toHaveBeenCalled();
  });

  it("settles the mount-time HealthKit permission check without React act warnings", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await renderProvidersScreen();

    const actWarnings = consoleError.mock.calls.filter((call) =>
      call.some((entry) => String(entry).includes("not wrapped in act")),
    );
    consoleError.mockRestore();
    expect(actWarnings).toEqual([]);
  });

  it("renders provider cards even while provider stats are still loading", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [connectedProvider],
      isLoading: false,
      error: null,
    });
    mockStatsQuery.mockReturnValue({
      data: [],
      isLoading: true,
      error: null,
    });

    await renderProvidersScreen();

    await waitFor(() => {
      expect(screen.getByTestId("provider-card-wahoo")).toBeTruthy();
    });
  });

  it("does not render Sync link for disconnected providers", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [disconnectedProvider],
      isLoading: false,
      error: null,
    });

    await renderProvidersScreen();

    const stravaCard = within(screen.getByTestId("provider-card-strava"));
    expect(stravaCard.queryByText("Sync")).toBeNull();
  });

  it("renders Full Sync All button alongside Sync All", async () => {
    await renderProvidersScreen();

    expect(screen.getByText("Sync recent data")).toBeTruthy();
    expect(screen.getByText("Updates the last 7 days for every connected provider.")).toBeTruthy();
    expect(screen.getByText("Sync full history…")).toBeTruthy();
  });

  it("renders dataset-level processing progress on the provider list", async () => {
    mockDataHealthQuery.mockReturnValue({
      data: {
        overallStatus: "active",
        generatedAt: "2026-06-30T08:00:00.000Z",
        scope: { providerId: null, datasets: ["providers"] },
        operations: [],
        datasets: [
          {
            key: "sleep",
            label: "Sleep",
            rawRows: 12,
            latestRawAt: "2026-06-30T07:00:00.000Z",
            latestReadModelAt: null,
            cdcLagSeconds: null,
            readModelLagSeconds: null,
            status: "active",
            progressPercentage: 60,
            message: "Sleep summaries are updating.",
          },
        ],
      },
      isLoading: false,
      error: null,
    });

    await renderProvidersScreen();

    expect(screen.getByText("Recomputing sleep")).toBeTruthy();
  });

  it("shows an explicit error when providers fail to load", async () => {
    mockProvidersQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Providers failed"),
    });

    await renderProvidersScreen();

    expect(screen.getByText("Providers failed")).toBeTruthy();
  });

  it("keeps cached providers visible when a background refresh fails", async () => {
    const refreshError = new Error(
      "Analytics data is temporarily unavailable. Please retry in a minute.",
    );
    mockProvidersQuery.mockReturnValue({
      data: [connectedProvider],
      isLoading: false,
      error: refreshError,
    });

    await renderProvidersScreen();

    expect(screen.getByTestId("provider-card-wahoo")).toBeTruthy();
    expect(screen.getByText(refreshError.message)).toBeTruthy();
  });

  it("shows an explicit error when sync history fails to load", async () => {
    mockLogsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Logs failed"),
    });

    await renderProvidersScreen();

    expect(screen.getByText("Logs failed")).toBeTruthy();
  });

  it("keeps cached provider stats visible when their background refresh fails", async () => {
    mockStatsQuery.mockReturnValue({
      data: [
        {
          providerId: "wahoo",
          totalRecords: 42,
          activities: 42,
          metricStream: 0,
          dailyMetrics: 0,
          sleepSessions: 0,
          bodyMeasurements: 0,
          foodEntries: 0,
          nutritionDaily: 0,
          healthEvents: 0,
          labPanels: 0,
          labResults: 0,
          journalEntries: 0,
        },
      ],
      isLoading: false,
      error: new Error("Provider statistics refresh failed"),
    });

    await renderProvidersScreen();

    expect(screen.getAllByText("42").length).toBeGreaterThan(0);
    expect(screen.getByText("Provider statistics refresh failed")).toBeTruthy();
  });

  it("keeps cached sync history visible when its background refresh fails", async () => {
    mockLogsQuery.mockReturnValue({
      data: [
        {
          id: "log-1",
          providerId: "wahoo",
          dataType: "activities",
          status: "success",
          recordCount: 12,
          errorMessage: null,
          authFailureReason: null,
          durationMs: 100,
          syncedAt: "2026-07-24T12:00:00.000Z",
        },
      ],
      isLoading: false,
      error: new Error("Sync history refresh failed"),
    });

    await renderProvidersScreen();

    expect(screen.getByText("activities")).toBeTruthy();
    expect(screen.getByText("Sync history refresh failed")).toBeTruthy();
  });

  it("shows the active sync server error message", async () => {
    mockActiveSyncsQuery.mockReturnValue({
      data: [],
      isLoading: false,
      error: new Error("Active syncs are temporarily unavailable. Please try again."),
    });

    await renderProvidersScreen();

    expect(
      screen.getByText("Active syncs are temporarily unavailable. Please try again."),
    ).toBeTruthy();
  });

  it("keeps provider progress visible while sync status retries", async () => {
    vi.useFakeTimers();
    try {
      mockActiveSyncsQuery.mockReturnValue({
        data: [
          {
            jobId: "wahoo:active-job",
            status: "running",
            percentage: 40,
            providers: {
              wahoo: { status: "running", message: "Downloading activities..." },
            },
          },
        ],
        isLoading: false,
        error: null,
      });
      mockSyncStatusFetch
        .mockRejectedValueOnce(
          new Error("Sync status is temporarily unavailable. Please try again."),
        )
        .mockResolvedValueOnce({
          status: "running",
          percentage: 60,
          providers: {
            wahoo: { status: "running", message: "Fetching activities..." },
          },
        })
        .mockImplementationOnce(() => new Promise(() => undefined));

      const rendered = await renderProvidersScreen();
      await act(async () => Promise.resolve());

      const wahooCard = within(screen.getByTestId("provider-card-wahoo"));
      expect(
        wahooCard.getByText("Sync status is temporarily unavailable. Please try again."),
      ).toBeTruthy();
      expect(
        screen.getByTestId("provider-card-wahoo-progress-fill").getAttribute("data-style"),
      ).toContain('"width":"40%"');

      await act(() => vi.advanceTimersByTimeAsync(1000));

      expect(wahooCard.getByText("Fetching activities...")).toBeTruthy();
      expect(
        screen.getByTestId("provider-card-wahoo-progress-fill").getAttribute("data-style"),
      ).toContain('"width":"60%"');
      rendered.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not apply the first retry error to completed providers from a resumed job", async () => {
    vi.useFakeTimers();
    try {
      mockProvidersQuery.mockReturnValue({
        data: [
          connectedProvider,
          {
            id: "garmin",
            name: "Garmin",
            authType: "oauth",
            authorized: true,
            importOnly: false,
            lastSyncedAt: null,
          },
        ],
        isLoading: false,
        error: null,
      });
      mockActiveSyncsQuery.mockReturnValue({
        data: [
          {
            jobId: "mixed-cached-job",
            status: "running",
            percentage: 40,
            providers: {
              wahoo: { status: "done", message: "Wahoo complete" },
              garmin: { status: "running", message: "Downloading Garmin activities..." },
            },
          },
        ],
        isLoading: false,
        error: null,
      });
      mockSyncStatusFetch.mockRejectedValueOnce(
        new Error("Sync status is temporarily unavailable. Please try again."),
      );
      mockSyncMutateAsync.mockImplementation(() => new Promise(() => undefined));

      const rendered = await renderProvidersScreen();
      await act(async () => Promise.resolve());

      const wahooCard = within(screen.getByTestId("provider-card-wahoo"));
      const garminCard = within(screen.getByTestId("provider-card-garmin"));
      expect(
        garminCard.getByText("Sync status is temporarily unavailable. Please try again."),
      ).toBeTruthy();
      expect(
        screen.getByTestId("provider-card-garmin-progress-fill").getAttribute("data-style"),
      ).toContain('"width":"40%"');

      fireEvent.click(wahooCard.getByText("Sync"));

      expect(
        wahooCard.queryByText("Sync status is temporarily unavailable. Please try again."),
      ).toBeNull();
      rendered.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying sync status when unmounted during the retry delay", async () => {
    vi.useFakeTimers();
    try {
      mockActiveSyncsQuery.mockReturnValue({
        data: [
          {
            jobId: "wahoo:active-job",
            status: "running",
            percentage: 40,
            providers: {
              wahoo: { status: "running", message: "Downloading activities..." },
            },
          },
        ],
        isLoading: false,
        error: null,
      });
      mockSyncStatusFetch
        .mockRejectedValueOnce(
          new Error("Sync status is temporarily unavailable. Please try again."),
        )
        .mockResolvedValueOnce({
          status: "completed",
          percentage: 100,
          providers: {
            wahoo: { status: "done", message: "Done" },
          },
        });

      const rendered = await renderProvidersScreen();
      await act(async () => Promise.resolve());
      expect(mockSyncStatusFetch).toHaveBeenCalledTimes(1);

      rendered.unmount();
      await act(() => vi.advanceTimersByTimeAsync(1000));

      expect(mockSyncStatusFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("overlays retry errors only on providers still active in a mixed job", async () => {
    vi.useFakeTimers();
    try {
      mockProvidersQuery.mockReturnValue({
        data: [
          connectedProvider,
          {
            id: "garmin",
            name: "Garmin",
            authType: "oauth",
            authorized: true,
            importOnly: false,
            lastSyncedAt: null,
          },
          {
            id: "strava",
            name: "Strava",
            authType: "oauth",
            authorized: true,
            importOnly: false,
            lastSyncedAt: null,
          },
        ],
        isLoading: false,
        error: null,
      });
      mockActiveSyncsQuery.mockReturnValue({
        data: [
          {
            jobId: "multi-provider-active-job",
            status: "running",
            percentage: 20,
            providers: {
              wahoo: { status: "running", message: "Syncing Wahoo..." },
              garmin: { status: "running", message: "Syncing Garmin..." },
              strava: { status: "running", message: "Syncing Strava..." },
            },
          },
        ],
        isLoading: false,
        error: null,
      });
      mockSyncStatusFetch
        .mockResolvedValueOnce({
          status: "running",
          percentage: 50,
          providers: {
            wahoo: { status: "done", message: "Wahoo complete" },
            garmin: { status: "error", message: "Garmin failed" },
            strava: { status: "running", message: "Fetching Strava activities..." },
          },
        })
        .mockRejectedValueOnce(
          new Error("Sync status is temporarily unavailable. Please try again."),
        );
      mockSyncMutateAsync.mockImplementation(() => new Promise(() => undefined));

      const rendered = await renderProvidersScreen();
      await act(async () => Promise.resolve());
      await act(() => vi.advanceTimersByTimeAsync(1000));

      const wahooCard = within(screen.getByTestId("provider-card-wahoo"));
      const garminCard = within(screen.getByTestId("provider-card-garmin"));
      const stravaCard = within(screen.getByTestId("provider-card-strava"));
      expect(
        stravaCard.getByText("Sync status is temporarily unavailable. Please try again."),
      ).toBeTruthy();
      expect(
        screen.getByTestId("provider-card-strava-progress-fill").getAttribute("data-style"),
      ).toContain('"width":"50%"');

      fireEvent.click(wahooCard.getByText("Sync"));
      fireEvent.click(garminCard.getByText("Sync"));

      expect(
        wahooCard.queryByText("Sync status is temporarily unavailable. Please try again."),
      ).toBeNull();
      expect(
        garminCard.queryByText("Sync status is temporarily unavailable. Please try again."),
      ).toBeNull();
      rendered.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes sinceDays: 7 when Sync button is clicked", async () => {
    mockSyncMutateAsync.mockResolvedValue({ jobId: "job-1" });
    mockSyncStatusFetch.mockResolvedValue({
      status: "done",
      providers: { wahoo: { status: "done" } },
    });

    await renderProvidersScreen();

    const wahooCard = within(screen.getByTestId("provider-card-wahoo"));
    fireEvent.click(wahooCard.getByText("Sync"));

    await waitFor(() => {
      expect(mockSyncMutateAsync).toHaveBeenCalledWith({
        providerId: "wahoo",
        sinceDays: 7,
      });
    });
    await waitFor(() => {
      expect(mockSyncStatusFetch).toHaveBeenCalledWith({ jobId: "job-1" }, { staleTime: 0 });
    });
  });

  it("does not update state when Sync All fails after unmount", async () => {
    let rejectSync: (error: Error) => void = () => undefined;
    mockSyncMutateAsync.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectSync = reject;
        }),
    );

    const rendered = await renderProvidersScreen();
    fireEvent.click(screen.getByText("Sync recent data"));
    rendered.unmount();

    await act(async () => {
      rejectSync(new Error("Sync failed"));
      await Promise.resolve();
    });
  });

  it("shows the exact bulk sync startup error", async () => {
    const error = new Error("Provider queues unavailable. Try again.");
    mockSyncMutateAsync.mockRejectedValue(error);

    await renderProvidersScreen();
    fireEvent.click(screen.getByText("Sync recent data"));

    await waitFor(() => {
      expect(screen.getByText(error.message)).toBeTruthy();
    });
  });

  it("shows provider cooldown outcome without polling a fake job", async () => {
    mockSyncMutateAsync.mockResolvedValue({
      jobId: "job-skipped",
      jobIds: [],
      providerJobs: [],
      providerResults: [
        {
          providerId: "wahoo",
          status: "skippedCooldown",
          message: "Provider sync skipped: rate-limit cooldown active",
        },
      ],
    });

    await renderProvidersScreen();

    const wahooCard = within(screen.getByTestId("provider-card-wahoo"));
    fireEvent.click(wahooCard.getByText("Sync"));

    await waitFor(() => {
      expect(wahooCard.getByText("Provider sync skipped: rate-limit cooldown active")).toBeTruthy();
    });
    expect(mockSyncStatusFetch).not.toHaveBeenCalled();
  });

  it("keeps Sync All disabled when another provider is still polling", async () => {
    const garminProvider = {
      id: "garmin",
      name: "Garmin",
      authType: "oauth",
      authorized: true,
      importOnly: false,
      lastSyncedAt: null,
    };
    mockProvidersQuery.mockReturnValue({
      data: [connectedProvider, garminProvider],
      isLoading: false,
      error: null,
    });
    mockActiveSyncsQuery.mockReturnValue({
      data: [
        {
          jobId: "garmin:active-job",
          status: "running",
          providers: { garmin: { status: "running", message: "Syncing Garmin" } },
        },
      ],
    });
    mockSyncStatusFetch.mockImplementation(() => new Promise(() => {}));
    mockSyncMutateAsync.mockResolvedValue({
      jobId: "job-skipped",
      jobIds: [],
      providerJobs: [],
      providerResults: [
        {
          providerId: "wahoo",
          status: "skippedCooldown",
          message: "Provider sync skipped: rate-limit cooldown active",
        },
      ],
    });

    await renderProvidersScreen();

    await waitFor(() => {
      expect(
        screen.getByText("Sync full history…").closest("button")?.hasAttribute("disabled"),
      ).toBe(true);
    });

    const wahooCard = within(screen.getByTestId("provider-card-wahoo"));
    fireEvent.click(wahooCard.getByText("Sync"));

    await waitFor(() => {
      expect(wahooCard.getByText("Provider sync skipped: rate-limit cooldown active")).toBeTruthy();
    });
    expect(screen.getByText("Sync full history…").closest("button")?.hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("keeps Sync All disabled when another provider is still polling", async () => {
    const garminProvider = {
      id: "garmin",
      name: "Garmin",
      authType: "oauth",
      authorized: true,
      importOnly: false,
      lastSyncedAt: null,
    };
    mockProvidersQuery.mockReturnValue({
      data: [connectedProvider, garminProvider],
      isLoading: false,
      error: null,
    });
    mockActiveSyncsQuery.mockReturnValue({
      data: [
        {
          jobId: "garmin:active-job",
          status: "running",
          providers: { garmin: { status: "running", message: "Syncing Garmin" } },
        },
      ],
    });
    mockSyncStatusFetch.mockImplementation(() => new Promise(() => {}));
    mockSyncMutateAsync.mockResolvedValue({
      jobId: "job-skipped",
      jobIds: [],
      providerJobs: [],
      providerResults: [
        {
          providerId: "wahoo",
          status: "skippedCooldown",
          message: "Provider sync skipped: rate-limit cooldown active",
        },
      ],
    });

    await renderProvidersScreen();

    await waitFor(() => {
      expect(
        screen.getByText("Sync full history…").closest("button")?.hasAttribute("disabled"),
      ).toBe(true);
    });

    const wahooCard = within(screen.getByTestId("provider-card-wahoo"));
    fireEvent.click(wahooCard.getByText("Sync"));

    await waitFor(() => {
      expect(wahooCard.getByText("Provider sync skipped: rate-limit cooldown active")).toBeTruthy();
    });
    expect(screen.getByText("Sync full history…").closest("button")?.hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("passes sinceDays: ROUTINE_SYNC_DAYS when Sync link is clicked", async () => {
    mockSyncMutateAsync.mockResolvedValue({ jobId: "job-2" });
    mockSyncStatusFetch.mockResolvedValue({
      status: "done",
      providers: { wahoo: { status: "done" } },
    });

    await renderProvidersScreen();

    const wahooCard = within(screen.getByTestId("provider-card-wahoo"));
    fireEvent.click(wahooCard.getByText("Sync"));

    await waitFor(() => {
      expect(mockSyncMutateAsync).toHaveBeenCalledWith({
        providerId: "wahoo",
        sinceDays: ROUTINE_SYNC_DAYS,
      });
    });
    await waitFor(() => {
      expect(mockSyncStatusFetch).toHaveBeenCalledWith({ jobId: "job-2" }, { staleTime: 0 });
    });
  });

  it("passes sinceDays: 7 when Sync All is clicked", async () => {
    mockSyncMutateAsync.mockResolvedValue({ jobId: "job-3", providerJobs: [] });
    mockSyncStatusFetch.mockResolvedValue({
      status: "done",
      providers: { wahoo: { status: "done" } },
    });

    await renderProvidersScreen();

    fireEvent.click(screen.getByText("Sync recent data"));

    await waitFor(() => {
      expect(mockSyncMutateAsync).toHaveBeenCalledWith({ sinceDays: 7 });
    });
  });

  it("shows sync-all provider cooldown outcomes without polling fake jobs", async () => {
    mockSyncMutateAsync.mockResolvedValue({
      jobId: "job-skipped",
      jobIds: [],
      providerJobs: [],
      providerResults: [
        {
          providerId: "wahoo",
          status: "skippedCooldown",
          message: "Provider sync skipped: rate-limit cooldown active",
        },
      ],
    });

    await renderProvidersScreen();

    fireEvent.click(screen.getByText("Sync recent data"));

    const wahooCard = within(screen.getByTestId("provider-card-wahoo"));
    await waitFor(() => {
      expect(wahooCard.getByText("Provider sync skipped: rate-limit cooldown active")).toBeTruthy();
    });
    expect(mockSyncStatusFetch).not.toHaveBeenCalled();
  });

  it("shows sync-all failed provider outcomes without polling fake jobs", async () => {
    mockSyncMutateAsync.mockResolvedValue({
      jobId: "job-failed",
      jobIds: [],
      providerJobs: [],
      providerResults: [
        {
          providerId: "wahoo",
          status: "failed",
          message: "provider queue unavailable",
        },
      ],
    });

    await renderProvidersScreen();

    fireEvent.click(screen.getByText("Sync recent data"));

    const wahooCard = within(screen.getByTestId("provider-card-wahoo"));
    await waitFor(() => {
      expect(wahooCard.getByText("provider queue unavailable")).toBeTruthy();
    });
    expect(mockSyncStatusFetch).not.toHaveBeenCalled();
  });

  it("polls provider-scoped job ids for sync-all started and already queued outcomes", async () => {
    const garminProvider = {
      id: "garmin",
      name: "Garmin",
      authType: "oauth",
      authorized: true,
      importOnly: false,
      lastSyncedAt: null,
    };
    mockProvidersQuery.mockReturnValue({
      data: [connectedProvider, garminProvider],
      isLoading: false,
      error: null,
    });
    mockSyncMutateAsync.mockResolvedValue({
      jobId: "wahoo:job-wahoo",
      jobIds: ["wahoo:job-wahoo", "garmin:job-garmin"],
      providerJobs: [
        { providerId: "wahoo", jobId: "wahoo:job-wahoo", queueName: "sync-wahoo" },
        { providerId: "garmin", jobId: "garmin:job-garmin", queueName: "sync-garmin" },
      ],
      providerResults: [
        {
          providerId: "wahoo",
          status: "started",
          jobId: "wahoo:job-wahoo",
          queueName: "sync-wahoo",
        },
        {
          providerId: "garmin",
          status: "alreadyQueued",
          jobId: "garmin:job-garmin",
          queueName: "sync-garmin",
        },
      ],
    });
    mockSyncStatusFetch.mockResolvedValue({
      status: "done",
      providers: {
        wahoo: { status: "done" },
        garmin: { status: "done" },
      },
    });

    await renderProvidersScreen();

    fireEvent.click(screen.getByText("Sync recent data"));

    await waitFor(() => {
      expect(mockSyncStatusFetch).toHaveBeenCalledWith(
        { jobId: "wahoo:job-wahoo" },
        { staleTime: 0 },
      );
      expect(mockSyncStatusFetch).toHaveBeenCalledWith(
        { jobId: "garmin:job-garmin" },
        { staleTime: 0 },
      );
    });
  });

  it("confirms before passing sinceDays: undefined for full history", async () => {
    mockSyncMutateAsync.mockResolvedValue({ jobId: "job-4", providerJobs: [] });
    mockSyncStatusFetch.mockResolvedValue({
      status: "done",
      providers: { wahoo: { status: "done" } },
    });

    await renderProvidersScreen();

    fireEvent.click(screen.getByText("Sync full history…"));
    expect(screen.getByText(/all history each connected provider makes available/i)).toBeTruthy();
    expect(mockSyncMutateAsync).not.toHaveBeenCalled();
    const cancelButton = screen.getByText("Cancel").closest("button");
    await waitFor(() =>
      expect(mockSendAccessibilityEvent).toHaveBeenCalledWith(cancelButton, "focus"),
    );
    fireEvent.click(screen.getByText("Start full sync"));

    await waitFor(() => {
      expect(mockSyncMutateAsync).toHaveBeenCalledWith({ sinceDays: undefined });
    });
  });

  it("opens credential auth modal when Connect is clicked on a credential provider", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [credentialProvider],
      isLoading: false,
    });

    await renderProvidersScreen();

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

    await renderProvidersScreen();

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

  it("opens the server-described personal token flow", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [tokenProvider],
      isLoading: false,
    });

    await renderProvidersScreen();

    const providerCard = within(screen.getByTestId("provider-card-wger"));
    fireEvent.click(providerCard.getByText("Connect"));

    await waitFor(() => {
      expect(screen.getByText("Connect Wger")).toBeTruthy();
      expect(screen.getByPlaceholderText("JWT refresh token")).toBeTruthy();
    });
  });

  it("surfaces and reports missing personal-token metadata", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [{ ...tokenProvider, tokenAuth: null }],
      isLoading: false,
    });
    const { captureException } = await import("../../lib/telemetry");
    const mockCaptureException = vi.mocked(captureException);
    mockCaptureException.mockClear();

    await renderProvidersScreen();
    fireEvent.click(within(screen.getByTestId("provider-card-wger")).getByText("Connect"));

    expect(mockAlert).toHaveBeenCalledWith(
      "Unable to connect provider",
      "Wger personal-token authentication is unavailable. Refresh and try again.",
    );
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      context: "connect-provider-list",
      providerId: "wger",
    });
    expect(mockCaptureException.mock.calls[0]?.[0]).toMatchObject({
      message: "Wger personal-token authentication is unavailable. Refresh and try again.",
    });
  });

  it("personal token auth calls the token connection mutation", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [tokenProvider],
      isLoading: false,
    });
    mockTokenConnect.mockResolvedValue({ success: true });
    await renderProvidersScreen();

    fireEvent.click(within(screen.getByTestId("provider-card-wger")).getByText("Connect"));
    fireEvent.change(screen.getByPlaceholderText("JWT refresh token"), {
      target: { value: "personal-refresh" },
    });
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Connect Wger" }),
    );

    await waitFor(() => {
      expect(mockTokenConnect).toHaveBeenCalledWith({
        providerId: "wger",
        token: "personal-refresh",
      });
    });
  });

  it("calls importSharedFile when sharedFile param is present", async () => {
    mockImportSharedFile.mockResolvedValue({ providerId: "strong-csv", jobId: "job-share" });
    mockUseLocalSearchParams.mockReturnValue({
      sharedFile: "file:///tmp/Strong%20Export.csv",
    });

    await renderProvidersScreen();

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

  it("deletes a shared file and surfaces auth errors when importing without a session", async () => {
    mockAuthState.sessionToken = null;
    mockUseLocalSearchParams.mockReturnValue({
      sharedFile: "file:///tmp/Strong%20Export.csv",
    });

    await renderProvidersScreen();

    await waitFor(() => {
      expect(mockFileDelete).toHaveBeenCalledWith("file:///tmp/Strong%20Export.csv");
    });
    expect(mockImportSharedFile).not.toHaveBeenCalled();
    expect(screen.getByText("Sign in before importing a file")).toBeTruthy();
  });

  it("selects and imports a Garmin dump ZIP from the Garmin card", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [
        {
          id: "garmin-dump",
          name: "Garmin Dump",
          authType: "none",
          authorized: true,
          importOnly: true,
          lastSyncedAt: null,
        },
      ],
      isLoading: false,
      error: null,
    });
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///tmp/garmin-export.zip",
          name: "garmin-export.zip",
          mimeType: "application/zip",
        },
      ],
    });
    mockImportSharedFile.mockResolvedValue({ providerId: "garmin-dump", jobId: "job-garmin" });

    await renderProvidersScreen();

    const garminCard = within(screen.getByTestId("provider-card-garmin-dump"));
    fireEvent.click(garminCard.getByText("Import file"));

    await waitFor(() => {
      expect(mockGetDocumentAsync).toHaveBeenCalledWith({
        copyToCacheDirectory: true,
        multiple: false,
        type: ["application/zip", "application/x-zip-compressed"],
      });
      expect(mockImportSharedFile).toHaveBeenCalledWith(
        expect.objectContaining({
          fileUri: "file:///tmp/garmin-export.zip",
          providerId: "garmin-dump",
          serverUrl: "https://test.example.com",
          sessionToken: "test-token",
        }),
        expect.objectContaining({ readBlob: expect.any(Function) }),
      );
    });
  });

  it("selects and imports a Strong CSV from the Strong card", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [importOnlyProvider],
      isLoading: false,
      error: null,
    });
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///tmp/strong-export.csv",
          name: "strong-export.csv",
          mimeType: "text/csv",
        },
      ],
    });
    mockImportSharedFile.mockResolvedValue({ providerId: "strong-csv", jobId: "job-strong" });

    await renderProvidersScreen();

    const strongCard = within(screen.getByTestId("provider-card-strong-csv"));
    fireEvent.click(strongCard.getByText("Import file"));

    await waitFor(() => {
      expect(mockGetDocumentAsync).toHaveBeenCalledWith({
        copyToCacheDirectory: true,
        multiple: false,
        type: ["text/csv", "text/comma-separated-values", "application/csv", "text/plain"],
      });
      expect(mockImportSharedFile).toHaveBeenCalledWith(
        expect.objectContaining({
          fileUri: "file:///tmp/strong-export.csv",
          providerId: "strong-csv",
          serverUrl: "https://test.example.com",
          sessionToken: "test-token",
        }),
        expect.objectContaining({ readBlob: expect.any(Function) }),
      );
    });
  });

  it("selects and imports a Cronometer CSV from the Cronometer card", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [
        {
          ...importOnlyProvider,
          id: "cronometer-csv",
          name: "Cronometer",
        },
      ],
      isLoading: false,
      error: null,
    });
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///tmp/cronometer-export.csv",
          name: "cronometer-export.csv",
          mimeType: "text/csv",
        },
      ],
    });
    mockImportSharedFile.mockResolvedValue({
      providerId: "cronometer-csv",
      jobId: "job-cronometer",
    });

    await renderProvidersScreen();

    const cronometerCard = within(screen.getByTestId("provider-card-cronometer-csv"));
    fireEvent.click(cronometerCard.getByText("Import file"));

    await waitFor(() => {
      expect(mockGetDocumentAsync).toHaveBeenCalledWith({
        copyToCacheDirectory: true,
        multiple: false,
        type: ["text/csv", "text/comma-separated-values", "application/csv", "text/plain"],
      });
      expect(mockImportSharedFile).toHaveBeenCalledWith(
        expect.objectContaining({
          fileUri: "file:///tmp/cronometer-export.csv",
          providerId: "cronometer-csv",
          serverUrl: "https://test.example.com",
          sessionToken: "test-token",
        }),
        expect.objectContaining({ readBlob: expect.any(Function) }),
      );
    });
  });

  it("selects and imports a Kaya CSV from the Kaya card", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [
        {
          ...importOnlyProvider,
          id: "kaya-export",
          name: "Kaya",
        },
      ],
      isLoading: false,
      error: null,
    });
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///tmp/kaya-export.csv",
          name: "kaya-export.csv",
          mimeType: "text/csv",
        },
      ],
    });
    mockImportSharedFile.mockResolvedValue({
      providerId: "kaya-export",
      jobId: "job-kaya",
    });

    await renderProvidersScreen();

    const kayaCard = within(screen.getByTestId("provider-card-kaya-export"));
    fireEvent.click(kayaCard.getByText("Import file"));

    await waitFor(() => {
      expect(mockGetDocumentAsync).toHaveBeenCalledWith({
        copyToCacheDirectory: true,
        multiple: false,
        type: ["text/csv", "text/comma-separated-values", "application/csv", "text/plain"],
      });
      expect(mockImportSharedFile).toHaveBeenCalledWith(
        expect.objectContaining({
          fileUri: "file:///tmp/kaya-export.csv",
          providerId: "kaya-export",
          serverUrl: "https://test.example.com",
          sessionToken: "test-token",
        }),
        expect.objectContaining({ readBlob: expect.any(Function) }),
      );
    });
  });

  it("shows resumable progress for an in-flight Garmin import", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [
        {
          id: "garmin-dump",
          name: "Garmin Dump",
          authType: "none",
          authorized: true,
          importOnly: true,
          lastSyncedAt: null,
        },
      ],
      isLoading: false,
      error: null,
    });
    mockActiveImportsQuery.mockReturnValue({
      data: [
        {
          jobId: "job-garmin",
          providerId: "garmin-dump",
          status: "running",
          percentage: 64,
          message: "Importing activities",
        },
      ],
      error: null,
    });

    await renderProvidersScreen();

    const garminCard = within(screen.getByTestId("provider-card-garmin-dump"));
    expect(garminCard.getByText("Importing activities")).toBeTruthy();
    expect(garminCard.getByText("Loading...")).toBeTruthy();
    expect(
      screen.getByTestId("provider-card-garmin-dump-progress-fill").getAttribute("data-style"),
    ).toContain('"width":"64%"');
    expect(garminCard.queryByText("Import only")).toBeNull();
  });

  it("shows a user-facing error when active import progress cannot load", async () => {
    mockActiveImportsQuery.mockReturnValue({
      data: undefined,
      error: new Error("We couldn't check import progress. Please try again."),
    });

    await renderProvidersScreen();

    expect(screen.getByText("We couldn't check import progress. Please try again.")).toBeTruthy();
  });

  it("shows shared import progress while providers are still loading", async () => {
    mockProvidersQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });
    mockImportSharedFile.mockImplementation(
      async (args: { onProgress?: (state: unknown) => void }) => {
        args.onProgress?.({
          status: "processing",
          progress: 50,
          message: "Processing import...",
          providerId: "strong-csv",
        });
        return { providerId: "strong-csv", jobId: "job-share" };
      },
    );
    mockUseLocalSearchParams.mockReturnValue({
      sharedFile: "file:///tmp/Strong%20Export.csv",
    });

    await renderProvidersScreen();

    await waitFor(() => {
      expect(screen.getByText("Strong import processing")).toBeTruthy();
    });
    expect(screen.getByText("Processing import...")).toBeTruthy();
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

    await renderProvidersScreen();

    await waitFor(() => {
      expect(mockImportSharedFile).toHaveBeenCalled();
    });

    // router.replace should NOT be called while import is still in progress
    expect(mockReplace).not.toHaveBeenCalled();

    // Clean up: resolve the pending import
    resolveImport({ providerId: "strong-csv", jobId: "job-1" });
  });

  it("does not render a sync action for import-only providers", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [importOnlyProvider],
      isLoading: false,
    });

    await renderProvidersScreen();

    const strongCard = within(screen.getByTestId("provider-card-strong-csv"));
    expect(strongCard.getByText("Strong")).toBeTruthy();
    expect(strongCard.getByText("Import only")).toBeTruthy();
    expect(strongCard.queryByText("Sync")).toBeNull();
  });

  it("excludes import-only providers from Sync All", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [importOnlyProvider],
      isLoading: false,
    });

    await renderProvidersScreen();

    // Bulk sync controls should not appear when only import-only providers exist.
    expect(screen.queryByText("Sync recent data")).toBeNull();
  });

  it("does not render a sync action for push-only providers", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [pushOnlyProvider],
      isLoading: false,
    });

    await renderProvidersScreen();

    const appleHealthCard = within(screen.getByTestId("provider-card-apple-health"));
    expect(appleHealthCard.getByText("Apple Health")).toBeTruthy();
    expect(appleHealthCard.getByText("Push only")).toBeTruthy();
    expect(appleHealthCard.queryByText("Sync")).toBeNull();
  });

  it("excludes push-only providers from Sync All", async () => {
    mockProvidersQuery.mockReturnValue({
      data: [pushOnlyProvider],
      isLoading: false,
    });

    await renderProvidersScreen();

    expect(screen.queryByText("Sync recent data")).toBeNull();
    expect(screen.queryByText("Sync full history…")).toBeNull();
  });

  it("passes readBlob that uses Expo file blobs without wrapping bytes", async () => {
    mockImportSharedFile.mockResolvedValue({ providerId: "strong-csv", jobId: "job-share" });
    mockUseLocalSearchParams.mockReturnValue({
      sharedFile: "file:///tmp/strong.csv",
    });

    await renderProvidersScreen();

    await waitFor(() => {
      expect(mockImportSharedFile).toHaveBeenCalled();
    });

    const callArgs = mockImportSharedFile.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.[1]).toHaveProperty("readBlob");
    const readBlob: (uri: string) => Promise<Blob> = callArgs[1].readBlob;
    const originalBlob = globalThis.Blob;
    vi.stubGlobal(
      "Blob",
      class RejectingArrayBufferBlob extends originalBlob {
        constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
          if (parts?.some((part) => part instanceof ArrayBuffer || ArrayBuffer.isView(part))) {
            throw new Error(
              "Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported",
            );
          }
          super(parts, options);
        }
      },
    );

    try {
      const blob = await readBlob("file:///tmp/strong.csv");

      expect(mockFileBytes).not.toHaveBeenCalled();
      expect(blob.size).toBeGreaterThan(0);
      const text = await blob.text();
      expect(text).toContain("Workout Name");
      expect(mockFileDelete).toHaveBeenCalledWith("file:///tmp/strong.csv");
    } finally {
      vi.unstubAllGlobals();
    }
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

    await renderProvidersScreen();

    const polarCard = within(screen.getByTestId("provider-card-polar"));
    expect(polarCard.getByText("Expired")).toBeTruthy();
    expect(polarCard.getByText("Reconnect")).toBeTruthy();
  });

  it("opens browser for OAuth provider connect", async () => {
    const WebBrowser = await import("expo-web-browser");
    mockProvidersQuery.mockReturnValue({
      data: [disconnectedProvider],
      isLoading: false,
    });

    await renderProvidersScreen();

    const stravaCard = within(screen.getByTestId("provider-card-strava"));
    fireEvent.click(stravaCard.getByText("Connect"));

    await waitFor(() => {
      expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(
        "https://test.example.com/auth/provider/strava?code=provider-handoff-code",
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

    await renderProvidersScreen();

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

    await renderProvidersScreen();

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

    await renderProvidersScreen();

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

    await renderProvidersScreen();

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

    await renderProvidersScreen();

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

  it("does not render Apple Health as import-only when HealthKit is not available", async () => {
    mockIsHealthKitAvailable.mockReturnValue(false);
    mockHasEverAuthorized.mockReturnValue(false);

    await renderProvidersScreen();

    const appleCard = within(screen.getByTestId("provider-card-apple_health"));
    expect(appleCard.getByText("Apple Health")).toBeTruthy();
    expect(appleCard.queryByText("Import only")).toBeNull();
    expect(appleCard.getByText("Connect")).toBeTruthy();
  });

  it("renders Apple Health card when HealthKit is available", async () => {
    await renderProvidersScreen();

    expect(screen.getByTestId("provider-card-apple_health")).toBeTruthy();
    expect(screen.getByText("Apple Health")).toBeTruthy();
  });

  it("shows resumable progress for an in-flight Apple Health import", async () => {
    mockActiveImportsQuery.mockReturnValue({
      data: [
        {
          jobId: "job-apple-health",
          providerId: "apple_health",
          status: "running",
          percentage: 42,
          message: "Importing Apple Health data",
        },
      ],
      error: null,
    });

    await renderProvidersScreen();

    const appleCard = within(screen.getByTestId("provider-card-apple_health"));
    expect(appleCard.getByText("Importing Apple Health data")).toBeTruthy();
    expect(appleCard.getByText("Loading...")).toBeTruthy();
    expect(
      screen.getByTestId("provider-card-apple_health-progress-fill").getAttribute("data-style"),
    ).toContain('"width":"42%"');
  });

  it("selects and imports an Apple Health export from the Apple Health card", async () => {
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///tmp/apple-health-export.zip",
          name: "apple-health-export.zip",
          mimeType: "application/zip",
        },
      ],
    });
    mockImportSharedFile.mockResolvedValue({ providerId: "apple-health", jobId: "job-apple" });

    await renderProvidersScreen();

    await waitFor(() => {
      const appleCard = within(screen.getByTestId("provider-card-apple_health"));
      expect(appleCard.getByText("Import file")).toBeTruthy();
    });

    const appleCard = within(screen.getByTestId("provider-card-apple_health"));
    fireEvent.click(appleCard.getByText("Import file"));

    await waitFor(() => {
      expect(mockGetDocumentAsync).toHaveBeenCalledWith({
        copyToCacheDirectory: true,
        multiple: false,
        type: ["application/zip", "application/x-zip-compressed", "application/xml", "text/xml"],
      });
      expect(mockImportSharedFile).toHaveBeenCalledWith(
        expect.objectContaining({
          fileUri: "file:///tmp/apple-health-export.zip",
          providerId: "apple-health",
          serverUrl: "https://test.example.com",
          sessionToken: "test-token",
        }),
        expect.objectContaining({ readBlob: expect.any(Function) }),
      );
    });
  });

  it("triggers HealthKit sync with syncRangeDays: 7 when Sync is clicked", async () => {
    await renderProvidersScreen();

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

  it("shows an actionable message without reporting when Apple Health becomes locked", async () => {
    const { captureException } = await import("../../lib/telemetry");
    const mockCaptureException = vi.mocked(captureException);
    mockCaptureException.mockClear();
    mockSyncHealthKit.mockRejectedValueOnce(
      Object.assign(new Error("HealthKit data is unavailable while the device is locked"), {
        code: "HEALTHKIT_DATABASE_INACCESSIBLE",
      }),
    );
    await renderProvidersScreen();

    await waitFor(() => {
      const appleCard = within(screen.getByTestId("provider-card-apple_health"));
      expect(appleCard.getByText("Sync")).toBeTruthy();
    });

    const appleCard = within(screen.getByTestId("provider-card-apple_health"));
    fireEvent.click(appleCard.getByText("Sync"));

    await waitFor(() => {
      expect(appleCard.getByText("Device locked — unlock to sync Apple Health data")).toBeTruthy();
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("writes direct Dofek food entries back to Apple Health when Sync is clicked", async () => {
    await renderProvidersScreen();

    await waitFor(() => {
      const appleCard = within(screen.getByTestId("provider-card-apple_health"));
      expect(appleCard.getByText("Sync")).toBeTruthy();
    });

    const appleCard = within(screen.getByTestId("provider-card-apple_health"));
    fireEvent.click(appleCard.getByText("Sync"));

    await waitFor(() => {
      expect(mockSyncDofekFoodToHealthKit).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      );
    });
  });

  it("shows Connect button when HealthKit was never authorized", async () => {
    mockHasEverAuthorized.mockReturnValue(false);
    mockGetRequestStatus.mockResolvedValue("shouldRequest");

    await renderProvidersScreen();

    await waitFor(() => {
      const appleCard = within(screen.getByTestId("provider-card-apple_health"));
      expect(appleCard.getByText("Connect")).toBeTruthy();
    });
  });

  it("shows Apple Health as connected when current HealthKit permissions are already authorized", async () => {
    mockHasEverAuthorized.mockReturnValue(false);
    mockGetRequestStatus.mockResolvedValue("unnecessary");

    await renderProvidersScreen();

    await waitFor(() => {
      const appleCard = within(screen.getByTestId("provider-card-apple_health"));
      expect(appleCard.getByText("Sync")).toBeTruthy();
    });
  });

  it("calls requestPermissions when Connect is clicked on Apple Health", async () => {
    mockHasEverAuthorized.mockReturnValue(false);
    mockGetRequestStatus.mockResolvedValue("shouldRequest");

    await renderProvidersScreen();

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

  it("blocks duplicate Apple Health permission requests while connecting", async () => {
    let finishPermissionRequest: (granted: boolean) => void = () => undefined;
    mockHasEverAuthorized.mockReturnValue(true);
    mockGetRequestStatus.mockResolvedValue("shouldRequest");
    mockRequestPermissions.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishPermissionRequest = resolve;
      }),
    );

    await renderProvidersScreen();

    const permissionButton = await screen.findByRole("button", {
      name: "Review Apple Health permissions",
    });
    fireEvent.click(permissionButton);

    await waitFor(() => {
      expect(permissionButton.getAttribute("aria-busy")).toBe("true");
      expect(permissionButton).toHaveProperty("disabled", true);
    });
    fireEvent.click(permissionButton);
    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);

    finishPermissionRequest(true);
    await waitFor(() => {
      expect(permissionButton).toHaveProperty("disabled", false);
    });
  });

  it("shows denied Apple Health permissions separately from device unavailability", async () => {
    mockHasEverAuthorized.mockReturnValue(false);
    mockGetRequestStatus.mockResolvedValue("shouldRequest");
    mockRequestPermissions.mockResolvedValue(false);

    await renderProvidersScreen();

    await waitFor(() => {
      const appleCard = within(screen.getByTestId("provider-card-apple_health"));
      expect(appleCard.getByText("Connect")).toBeTruthy();
    });

    const appleCard = within(screen.getByTestId("provider-card-apple_health"));
    fireEvent.click(appleCard.getByText("Connect"));

    await waitFor(() => {
      expect(screen.getByText("Apple Health permissions were not granted")).toBeTruthy();
    });
  });

  it("reports error to Sentry when Apple Health connect fails", async () => {
    const { captureException } = await import("../../lib/telemetry");
    const mockCaptureException = vi.mocked(captureException);
    mockCaptureException.mockClear();

    const connectError = new Error("HealthKit authorization failed");
    mockHasEverAuthorized.mockReturnValue(false);
    mockGetRequestStatus.mockResolvedValue("shouldRequest");
    mockRequestPermissions.mockRejectedValue(connectError);

    await renderProvidersScreen();

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
    mockHasEverAuthorized.mockReturnValue(false);
    mockGetRequestStatus.mockResolvedValue("shouldRequest");
    mockRequestPermissions.mockRejectedValue(new Error("Authorization denied"));

    await renderProvidersScreen();

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

  it("shows entitlement error and keeps connect controls when Apple Health entitlement is missing", async () => {
    const { captureException } = await import("../../lib/telemetry");
    const mockCaptureException = vi.mocked(captureException);
    mockCaptureException.mockClear();

    mockHasEverAuthorized.mockReturnValue(false);
    mockGetRequestStatus.mockResolvedValue("shouldRequest");
    mockRequestPermissions.mockRejectedValue(
      new Error("Missing com.apple.developer.healthkit entitlement."),
    );

    await renderProvidersScreen();

    await waitFor(() => {
      const appleCard = within(screen.getByTestId("provider-card-apple_health"));
      expect(appleCard.getByText("Connect")).toBeTruthy();
    });

    const appleCard = within(screen.getByTestId("provider-card-apple_health"));
    fireEvent.click(appleCard.getByText("Connect"));

    // Should keep normal provider controls and surface a clear error
    await waitFor(() => {
      const card = within(screen.getByTestId("provider-card-apple_health"));
      expect(card.queryByText("Import only")).toBeNull();
      expect(card.getByText("Missing com.apple.developer.healthkit entitlement.")).toBeTruthy();
      expect(card.getByText("Connect")).toBeTruthy();
    });

    // Should report to Sentry
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("healthkit entitlement") }),
      expect.objectContaining({ context: "healthkit-connect" }),
    );
  });
});
