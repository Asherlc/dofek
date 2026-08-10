// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAlertFn = vi.fn();
const mockOpenBrowserAsync = vi.fn();
const mockGetRequestStatus = vi.fn().mockResolvedValue("unnecessary");
const mockHasEverAuthorized = vi.fn().mockReturnValue(true);
const mockRequestPermissions = vi.fn().mockResolvedValue(true);
const mockSyncHealthKit = vi.fn();
const mockDatePickerSelections = vi.hoisted(() => ({
  From: new Date(2026, 5, 1, 12),
  To: new Date(2026, 5, 15, 12),
}));

vi.mock("@react-native-community/datetimepicker", () => ({
  default: ({
    accessibilityLabel,
    maximumDate,
    onChange,
    value,
  }: {
    accessibilityLabel: "From" | "To";
    maximumDate?: Date;
    onChange: (event: { type: "set" }, date: Date) => void;
    value: Date;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        "data-maximum-time": maximumDate?.getTime(),
        "data-value-time": value.getTime(),
        onClick: () => onChange({ type: "set" }, mockDatePickerSelections[accessibilityLabel]),
      },
      [
        value.getFullYear(),
        String(value.getMonth() + 1).padStart(2, "0"),
        String(value.getDate()).padStart(2, "0"),
      ].join("-"),
    ),
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: {
    setAccessibilityFocus: vi.fn(),
  },
  findNodeHandle: vi.fn().mockReturnValue(1),
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: vi.fn() }),
  },
  View: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => {
    const { style: _s, contentContainerStyle: _cs, activeOpacity: _ao, ...rest } = props;
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
    const {
      style: _s,
      contentContainerStyle: _cs,
      showsHorizontalScrollIndicator: _sh,
      horizontal: _h,
      refreshControl: _rc,
      accessibilityLabel,
      accessibilityRole,
      ...rest
    } = props;
    return React.createElement(
      "div",
      { ...rest, "aria-label": accessibilityLabel, role: accessibilityRole },
      children,
    );
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
    const {
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      style: _s,
      activeOpacity: _ao,
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
        onClick: onPress,
        disabled,
        "aria-busy": "busy" in state ? state.busy : undefined,
        "aria-disabled": "disabled" in state ? state.disabled : undefined,
        "aria-expanded": "expanded" in state ? state.expanded : undefined,
        "aria-label": accessibilityLabel,
        "aria-selected": "selected" in state ? state.selected : undefined,
        role: accessibilityRole ?? "presentation",
        ...rest,
      },
      children,
    );
  },
  Pressable: ({
    children,
    onPress,
    disabled,
    ...props
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  } & Record<string, unknown>) => {
    const { style: _s, ...rest } = props;
    return React.createElement(
      "button",
      { type: "button", onClick: onPress, disabled, ...rest },
      children,
    );
  },
  TextInput: ({
    placeholder,
    value,
    onChangeText,
    ...props
  }: {
    placeholder?: string;
    value?: string;
    onChangeText?: (text: string) => void;
  } & Record<string, unknown>) => {
    const {
      style: _s,
      placeholderTextColor: _pc,
      keyboardType: _kt,
      secureTextEntry: _se,
      autoCapitalize: _ac,
      autoCorrect: _acr,
      ...rest
    } = props;
    return React.createElement("input", {
      type: "text",
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
    const {
      animationType: _at,
      transparent: _t,
      presentationStyle: _ps,
      onRequestClose: _orc,
      onShow: _os,
      ...rest
    } = props;
    return React.createElement("div", { role: "dialog", ...rest }, children);
  },
  Image: ({
    source: _source,
    style: _style,
    accessibilityElementsHidden: _aeh,
    ...props
  }: Record<string, unknown>) => React.createElement("img", props),
  ActivityIndicator: () => React.createElement("span", null, "Loading..."),
  Alert: { alert: mockAlertFn },
  Linking: { openURL: vi.fn() },
  StyleSheet: {
    create: <T extends Record<string, unknown>>(s: T): T => s,
    hairlineWidth: 1,
  },
}));

const mockBack = vi.fn();
const mockDismissTo = vi.fn();
const mockPush = vi.fn();
const mockUseLocalSearchParams = vi.fn().mockReturnValue({ id: "wahoo" });

vi.mock("expo-router", () => ({
  useRouter: () => ({
    back: mockBack,
    dismissTo: mockDismissTo,
    push: mockPush,
  }),
  useLocalSearchParams: (...args: unknown[]) => mockUseLocalSearchParams(...args),
}));

vi.mock("expo-web-browser", () => ({
  openBrowserAsync: (...args: unknown[]) => mockOpenBrowserAsync(...args),
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
  fonts: {
    mono: "monospace",
  },
  radius: {
    md: 8,
    lg: 12,
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
  },
}));

vi.mock("../../lib/auth-context", () => ({
  useAuth: () => ({
    serverUrl: "https://test.example.com",
    sessionToken: "test-token",
  }),
}));

vi.mock("@dofek/format/format", () => ({
  formatDateYmd: (date?: Date) => {
    const resolvedDate = date ?? new Date(2026, 6, 29, 12);
    return [
      resolvedDate.getFullYear(),
      String(resolvedDate.getMonth() + 1).padStart(2, "0"),
      String(resolvedDate.getDate()).padStart(2, "0"),
    ].join("-");
  },
  formatDurationSeconds: (seconds: number) => `${seconds} seconds`,
  formatRelativeTime: (date: string) => `${date} ago`,
  formatTableCellValue: (value: unknown) => String(value),
  formatTime: (date: string) => date,
}));

const mockProvidersQuery = vi.fn();
const mockProviderStatsQuery = vi.fn();
const mockDataHealthQuery = vi.fn();
const mockAvailableDataTypesQuery = vi.fn();
const mockRecordsQuery = vi.fn();
const mockLogsQuery = vi.fn();
const mockSyncMutateAsync = vi.fn();
const mockDisconnectMutateAsync = vi.fn();
const mockDeleteAllDataMutateAsync = vi.fn();
const mockDeletionStatusQuery = vi.fn().mockReturnValue({ data: undefined, error: null });
const mockInvalidateProviders = vi.fn();
const mockInvalidateProviderStats = vi.fn();
const mockInvalidateDataHealth = vi.fn();
const mockInvalidateAvailableDataTypes = vi.fn();
const mockInvalidateRecords = vi.fn();
const mockInvalidateDetailLogs = vi.fn();
const mockInvalidateLogs = vi.fn();
const mockSyncStatusFetch = vi.fn();
const mockSettingsGetQuery = vi.fn().mockReturnValue({ data: null, isLoading: false });
const mockSettingsSetMutate = vi.fn();
const mockSettingsGetGetData = vi.fn();
const mockSettingsGetSetData = vi.fn();
const mockSettingsGetInvalidate = vi.fn();
const mockCaptureException = vi.fn();
const mockTokenConnect = vi.fn();
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
      dismiss: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
      },
    },
    sync: {
      providers: { useQuery: (...args: unknown[]) => mockProvidersQuery(...args) },
      providerStats: { useQuery: (...args: unknown[]) => mockProviderStatsQuery(...args) },
      triggerSync: {
        useMutation: () => ({ mutateAsync: mockSyncMutateAsync, isPending: false }),
      },
    },
    providerDetail: {
      availableDataTypes: {
        useQuery: (...args: unknown[]) => mockAvailableDataTypesQuery(...args),
      },
      records: { useQuery: (...args: unknown[]) => mockRecordsQuery(...args) },
      logs: { useQuery: (...args: unknown[]) => mockLogsQuery(...args) },
      disconnect: {
        useMutation: () => ({ mutateAsync: mockDisconnectMutateAsync, isPending: false }),
      },
      deleteAllData: {
        useMutation: () => ({ mutateAsync: mockDeleteAllDataMutateAsync, isPending: false }),
      },
      deletionStatus: { useQuery: (...args: unknown[]) => mockDeletionStatusQuery(...args) },
    },
    settings: {
      get: { useQuery: (...args: unknown[]) => mockSettingsGetQuery(...args) },
      set: { useMutation: () => ({ mutate: mockSettingsSetMutate, isPending: false }) },
    },
    tokenAuth: {
      connect: { useMutation: () => ({ mutateAsync: mockTokenConnect }) },
    },
    useUtils: () => ({
      client: {},
      invalidate: vi.fn(),
      processing: {
        status: { invalidate: mockInvalidateDataHealth },
      },
      sync: {
        providers: { invalidate: mockInvalidateProviders },
        providerStats: { invalidate: mockInvalidateProviderStats },
        logs: { invalidate: mockInvalidateLogs },
        syncStatus: { fetch: mockSyncStatusFetch },
      },
      providerDetail: {
        availableDataTypes: { invalidate: mockInvalidateAvailableDataTypes },
        records: { invalidate: mockInvalidateRecords },
        logs: { invalidate: mockInvalidateDetailLogs },
      },
      settings: {
        get: {
          getData: mockSettingsGetGetData,
          setData: mockSettingsGetSetData,
          invalidate: mockSettingsGetInvalidate,
        },
      },
    }),
  },
}));

vi.mock("../../lib/telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

vi.mock("../../modules/health-kit", async () => {
  const { createEmptyAnchoredQueryResult } = await import("../../modules/health-kit/test-helpers");
  return {
    completeAnchoredQuery: vi.fn().mockResolvedValue(true),
    getRequestStatus: (...args: unknown[]) => mockGetRequestStatus(...args),
    hasEverAuthorized: (...args: unknown[]) => mockHasEverAuthorized(...args),
    isAvailable: () => true,
    queryAnchoredSamples: vi.fn().mockResolvedValue(createEmptyAnchoredQueryResult()),
    queryDailyStatistics: vi.fn(),
    queryQuantitySamples: vi.fn(),
    querySleepSamples: vi.fn(),
    queryWorkoutRoutes: vi.fn(),
    queryWorkouts: vi.fn(),
    requestPermissions: (...args: unknown[]) => mockRequestPermissions(...args),
  };
});

vi.mock("../../lib/health-kit-sync", () => ({
  syncHealthKitToServer: (...args: unknown[]) => mockSyncHealthKit(...args),
}));

const authorizedProvider = {
  id: "wahoo",
  name: "Wahoo",
  authType: "oauth",
  authorized: true,
  importOnly: false,
  lastSyncedAt: "2026-03-19T12:00:00Z",
  needsReauth: false,
};

const unauthorizedProvider = {
  id: "strava",
  name: "Strava",
  authType: "oauth",
  authorized: false,
  importOnly: false,
  lastSyncedAt: null,
  needsReauth: false,
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
  needsReauth: false,
};

const importOnlyProvider = {
  id: "strong-csv",
  name: "Strong",
  authType: "none",
  authorized: true,
  importOnly: true,
  lastSyncedAt: null,
  needsReauth: false,
};

const pushOnlyProvider = {
  id: "whoop-ble",
  name: "WHOOP BLE",
  authType: "none",
  authorized: true,
  importOnly: false,
  pushOnly: true,
  lastSyncedAt: null,
  needsReauth: false,
};

const appleHealthStats = {
  providerId: "apple_health",
  totalRecords: 0,
  activities: 0,
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
};

function setupDefaultMocks() {
  mockProvidersQuery.mockReturnValue({
    data: [authorizedProvider],
    error: null,
    isLoading: false,
  });
  mockProviderStatsQuery.mockReturnValue({ data: [], error: null, isLoading: false });
  mockDataHealthQuery.mockReturnValue({ data: null, isLoading: false, error: null });
  mockAvailableDataTypesQuery.mockReturnValue({
    data: ["activities"],
    isLoading: false,
    isError: false,
    error: null,
  });
  mockRecordsQuery.mockReturnValue({ data: { rows: [] }, isLoading: false });
  mockLogsQuery.mockReturnValue({ data: [], isLoading: false });
}

describe("ProviderDetailScreen", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: "provider-handoff-code" }), { status: 200 }),
        ),
    );
    mockBack.mockReset();
    mockDismissTo.mockReset();
    mockPush.mockReset();
    mockUseLocalSearchParams.mockReturnValue({ id: "wahoo" });
    mockSyncMutateAsync.mockReset();
    mockTokenConnect.mockReset();
    mockDataHealthQuery.mockReset();
    mockDisconnectMutateAsync.mockReset();
    mockDeletionStatusQuery.mockClear();
    mockInvalidateProviders.mockReset();
    mockInvalidateProviderStats.mockReset();
    mockInvalidateDataHealth.mockReset();
    mockInvalidateAvailableDataTypes.mockReset();
    mockInvalidateRecords.mockReset();
    mockInvalidateDetailLogs.mockReset();
    mockInvalidateLogs.mockReset();
    mockSyncStatusFetch.mockReset();
    mockOpenBrowserAsync.mockReset();
    mockGetRequestStatus.mockReset();
    mockGetRequestStatus.mockResolvedValue("unnecessary");
    mockHasEverAuthorized.mockReset();
    mockHasEverAuthorized.mockReturnValue(true);
    mockRequestPermissions.mockReset();
    mockRequestPermissions.mockResolvedValue(true);
    mockSyncHealthKit.mockReset();
    mockDatePickerSelections.From = new Date(2026, 5, 1, 12);
    mockDatePickerSelections.To = new Date(2026, 5, 15, 12);
    mockCaptureException.mockReset();
    mockAlertFn.mockReset();
    mockUseRefresh.mockClear();
    setupDefaultMocks();
  });

  describe("Unknown provider", () => {
    it("renders a not-found state without loading provider details", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "does-not-exist" });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Provider not found")).toBeTruthy();
      expect(
        screen.getByText("This provider is unavailable. Return to Data Sources to choose another."),
      ).toBeTruthy();
      expect(screen.queryByText("Does Not Exist")).toBeNull();
      expect(screen.queryByText("Sync History")).toBeNull();
      expect(screen.queryByText("Records")).toBeNull();
      expect(mockProviderStatsQuery).not.toHaveBeenCalled();
      expect(mockDataHealthQuery).not.toHaveBeenCalled();
      expect(mockAvailableDataTypesQuery).not.toHaveBeenCalled();
      expect(mockRecordsQuery).not.toHaveBeenCalled();
      expect(mockLogsQuery).not.toHaveBeenCalled();
      expect(mockDeletionStatusQuery).not.toHaveBeenCalled();
      expect(mockSyncMutateAsync).not.toHaveBeenCalled();
      expect(mockDisconnectMutateAsync).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Back to Data Sources" }));

      expect(mockDismissTo).toHaveBeenCalledWith("/providers");
    });

    it("shows the provider inventory error without loading provider details", async () => {
      mockProvidersQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: new Error("Provider inventory is temporarily unavailable"),
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Could not load provider")).toBeTruthy();
      expect(screen.getByText("Provider inventory is temporarily unavailable")).toBeTruthy();
      expect(mockProviderStatsQuery).not.toHaveBeenCalled();
      expect(mockDataHealthQuery).not.toHaveBeenCalled();
      expect(mockAvailableDataTypesQuery).not.toHaveBeenCalled();
      expect(mockRecordsQuery).not.toHaveBeenCalled();
      expect(mockLogsQuery).not.toHaveBeenCalled();
      expect(mockDeletionStatusQuery).not.toHaveBeenCalled();
    });

    it("keeps cached provider details visible after an inventory refresh failure", async () => {
      mockProvidersQuery.mockReturnValue({
        data: [authorizedProvider],
        isLoading: false,
        error: new Error("Provider inventory refresh failed"),
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Wahoo")).toBeTruthy();
      expect(screen.getByText("Provider inventory refresh failed")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Sync" })).toBeTruthy();
    });
  });

  describe("Sync history", () => {
    it("explains an expired provider authorization before exposing diagnostics", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "whoop" });
      mockProvidersQuery.mockReturnValue({
        data: [
          {
            ...authorizedProvider,
            id: "whoop",
            name: "WHOOP",
            authorized: false,
            needsReauth: true,
          },
        ],
        isLoading: false,
      });
      mockLogsQuery.mockReturnValue({
        data: [
          {
            id: "raw-log-123",
            syncedAt: "2026-07-24T12:00:00.000Z",
            dataType: "strength",
            status: "error",
            recordCount: null,
            durationMs: 1250,
            errorMessage: "OAuth token refresh returned invalid_grant",
            authFailureReason: "refresh_token_revoked",
          },
        ],
        isLoading: false,
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Authorization expired")).toBeTruthy();
      expect(screen.getByText("Reconnect WHOOP to resume Strength data.")).toBeTruthy();
      expect(screen.queryByText("refresh_token_revoked")).toBeNull();
    });
  });

  describe("Actions", () => {
    it("exposes provider actions by accessible role and name", async () => {
      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByRole("button", { name: "Sync" }).getAttribute("aria-label")).toBe("Sync");
      expect(screen.getByRole("button", { name: "Full sync" }).getAttribute("aria-label")).toBe(
        "Full sync",
      );
    });

    it("renders Sync and Full sync actions for connected providers", async () => {
      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Sync")).toBeTruthy();
      expect(screen.getByText("Full sync")).toBeTruthy();
      expect(screen.queryByText("Sync Range")).toBeNull();
    });

    it("renders Connect action for disconnected providers", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "strava" });
      mockProvidersQuery.mockReturnValue({ data: [unauthorizedProvider], isLoading: false });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Connect")).toBeTruthy();
      expect(screen.queryByText("Sync")).toBeNull();
      expect(screen.queryByText("Full sync")).toBeNull();
    });

    it("does not render actions for import-only providers", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "strong-csv" });
      mockProvidersQuery.mockReturnValue({ data: [importOnlyProvider], isLoading: false });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.queryByText("Connect")).toBeNull();
      expect(screen.queryByText("Sync")).toBeNull();
      expect(screen.queryByText("Full sync")).toBeNull();
    });

    it("does not render actions for push-only providers", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "whoop-ble" });
      mockProvidersQuery.mockReturnValue({ data: [pushOnlyProvider], isLoading: false });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("WHOOP BLE")).toBeTruthy();
      expect(screen.queryByText("Connect")).toBeNull();
      expect(screen.queryByText("Sync")).toBeNull();
      expect(screen.queryByText("Full sync")).toBeNull();
    });

    it("renders re-authorize button when provider needs reauth", async () => {
      mockProvidersQuery.mockReturnValue({
        data: [{ ...authorizedProvider, needsReauth: true }],
        isLoading: false,
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getAllByText("Reconnect")).toHaveLength(2);
      expect(screen.getByRole("button", { name: "Reconnect Wahoo" })).toBeTruthy();
      expect(screen.getByText("Connection")).toBeTruthy();
      expect(screen.getByText("Connected")).toBeTruthy();
      expect(screen.getByText("Authorization")).toBeTruthy();
      expect(screen.getByText("Reconnect required")).toBeTruthy();
      expect(screen.queryByText("Sync")).toBeNull();
      expect(screen.queryByText("Full sync")).toBeNull();
    });

    it("renders Reconnect for providers whose expired tokens were deleted", async () => {
      mockProvidersQuery.mockReturnValue({
        data: [{ ...authorizedProvider, authorized: false, needsReauth: true }],
        isLoading: false,
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getAllByText("Reconnect")).toHaveLength(2);
      expect(screen.getByRole("button", { name: "Reconnect Wahoo" })).toBeTruthy();
      expect(screen.queryByText("Connect")).toBeNull();
      expect(screen.queryByText("Sync")).toBeNull();
      expect(screen.queryByText("Full sync")).toBeNull();
    });

    it("shows provider processing progress while read models update", async () => {
      mockDataHealthQuery.mockReturnValue({
        data: {
          overallStatus: "active",
          generatedAt: "2026-06-30T12:00:00Z",
          scope: { providerId: "wahoo", datasets: ["activity"] },
          operations: [],
          datasets: [
            {
              key: "activity",
              label: "Activities",
              rawRows: 12,
              latestRawAt: "2026-06-29T12:00:00Z",
              latestReadModelAt: null,
              cdcLagSeconds: 90000,
              readModelLagSeconds: null,
              status: "active",
              message: "Activity data is available, but ClickHouse mirrors are not current.",
            },
          ],
        },
        isLoading: false,
        error: null,
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Wahoo data status")).toBeTruthy();
      expect(screen.getByText("Syncing Wahoo")).toBeTruthy();
    });

    it("keeps ready provider dataset freshness visible", async () => {
      mockDataHealthQuery.mockReturnValue({
        data: {
          overallStatus: "ready",
          generatedAt: "2026-06-30T14:00:00Z",
          scope: { providerId: "wahoo", datasets: ["activity"] },
          operations: [],
          datasets: [
            {
              key: "activity",
              label: "Activities",
              status: "ready",
              currentStage: null,
              progressPercentage: 100,
              lastAdvancedAt: "2026-06-30T12:00:00Z",
              lastReadyAt: "2026-06-30T12:00:00Z",
            },
          ],
        },
        isLoading: false,
        error: null,
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Last ready: 2026-06-30T12:00:00Z ago")).toBeTruthy();
    });

    it("triggers generic provider sync with sinceDays=7 when Sync is clicked", async () => {
      mockSyncMutateAsync.mockResolvedValue({ jobId: "job-1" });
      mockSyncStatusFetch.mockResolvedValue({
        status: "done",
        percentage: 100,
        providers: { wahoo: { status: "done", message: "Done" } },
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Sync"));

      await waitFor(() => {
        expect(mockSyncMutateAsync).toHaveBeenCalledWith({
          providerId: "wahoo",
          sinceDays: 7,
        });
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

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Sync"));

      await waitFor(() => {
        expect(screen.getByText("Provider sync skipped: rate-limit cooldown active")).toBeTruthy();
      });
      expect(mockSyncStatusFetch).not.toHaveBeenCalled();
    });

    it("keeps sync active and recovers from a transient server error", async () => {
      vi.useFakeTimers();
      try {
        mockSyncMutateAsync.mockResolvedValue({ jobId: "job-1" });
        mockSyncStatusFetch
          .mockRejectedValueOnce(
            new Error("Sync status is temporarily unavailable. Please try again."),
          )
          .mockResolvedValueOnce({
            status: "completed",
            percentage: 100,
            providers: { wahoo: { status: "done", message: "Done" } },
          });

        const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
        render(<ProviderDetailScreen />);
        fireEvent.click(screen.getByText("Sync"));
        await act(async () => Promise.resolve());

        expect(
          screen.getByText("Sync status is temporarily unavailable. Please try again."),
        ).toBeTruthy();
        expect(screen.getByRole("button", { name: "Sync" }).getAttribute("aria-busy")).toBe("true");

        await act(() => vi.advanceTimersByTimeAsync(1000));

        expect(screen.getByText("Sync complete")).toBeTruthy();
        expect(mockSyncStatusFetch).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops retrying sync status when unmounted during the retry delay", async () => {
      vi.useFakeTimers();
      try {
        mockSyncMutateAsync.mockResolvedValue({ jobId: "job-1" });
        mockSyncStatusFetch
          .mockRejectedValueOnce(
            new Error("Sync status is temporarily unavailable. Please try again."),
          )
          .mockResolvedValueOnce({
            status: "completed",
            percentage: 100,
            providers: { wahoo: { status: "done", message: "Done" } },
          });

        const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
        const rendered = render(<ProviderDetailScreen />);
        fireEvent.click(screen.getByText("Sync"));
        await act(async () => Promise.resolve());
        expect(mockSyncStatusFetch).toHaveBeenCalledTimes(1);

        rendered.unmount();
        await act(() => vi.advanceTimersByTimeAsync(1000));

        expect(mockSyncStatusFetch).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("triggers generic provider full sync when Full sync is clicked", async () => {
      mockSyncMutateAsync.mockResolvedValue({ jobId: "job-2" });
      mockSyncStatusFetch.mockResolvedValue({
        status: "done",
        percentage: 100,
        providers: { wahoo: { status: "done", message: "Done" } },
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Full sync"));

      await waitFor(() => {
        expect(mockSyncMutateAsync).toHaveBeenCalledWith({
          providerId: "wahoo",
          sinceDays: undefined,
        });
      });
    });

    it("opens browser auth when Connect is clicked for an oauth provider", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "strava" });
      mockProvidersQuery.mockReturnValue({ data: [unauthorizedProvider], isLoading: false });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      await waitFor(() => {
        expect(screen.getByText("Connect")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Connect"));

      await waitFor(() => {
        expect(mockOpenBrowserAsync).toHaveBeenCalledWith(
          "https://test.example.com/auth/provider/strava?code=provider-handoff-code",
        );
      });
    });

    it("opens and submits personal token auth for a token provider", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "wger" });
      mockProvidersQuery.mockReturnValue({ data: [tokenProvider], isLoading: false });
      mockTokenConnect.mockResolvedValue({ success: true });
      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Connect"));
      fireEvent.change(screen.getByPlaceholderText("JWT refresh token"), {
        target: { value: "personal-refresh" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Connect Wger" }));

      await waitFor(() => {
        expect(mockTokenConnect).toHaveBeenCalledWith({
          providerId: "wger",
          token: "personal-refresh",
        });
      });
    });

    it("surfaces and reports missing personal-token metadata", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "wger" });
      mockProvidersQuery.mockReturnValue({
        data: [{ ...tokenProvider, tokenAuth: null }],
        isLoading: false,
      });
      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Connect"));

      await waitFor(() => {
        expect(
          screen.getByText(
            "Wger personal-token authentication is unavailable. Refresh and try again.",
          ),
        ).toBeTruthy();
      });
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
        context: "connect-provider-detail",
        providerId: "wger",
      });
      expect(mockCaptureException.mock.calls[0]?.[0]).toMatchObject({
        message: "Wger personal-token authentication is unavailable. Refresh and try again.",
      });
    });

    it("triggers Apple Health sync with syncRangeDays: 7 when Sync is clicked", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "apple_health" });
      mockProvidersQuery.mockReturnValue({ data: [authorizedProvider], isLoading: false });
      mockProviderStatsQuery.mockReturnValue({ data: [appleHealthStats], isLoading: false });
      mockSyncHealthKit.mockResolvedValue({ inserted: 12, errors: [] });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      await waitFor(() => {
        expect(screen.getByText("Sync")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Sync"));

      await waitFor(() => {
        expect(mockSyncHealthKit).toHaveBeenCalledWith(
          expect.objectContaining({ syncRangeDays: 7 }),
        );
      });
    });

    it("shows an actionable message without reporting when Apple Health becomes locked", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "apple_health" });
      mockProvidersQuery.mockReturnValue({ data: [authorizedProvider], isLoading: false });
      mockProviderStatsQuery.mockReturnValue({ data: [appleHealthStats], isLoading: false });
      mockSyncHealthKit.mockRejectedValueOnce(
        Object.assign(new Error("HealthKit data is unavailable while the device is locked"), {
          code: "HEALTHKIT_DATABASE_INACCESSIBLE",
        }),
      );

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      await waitFor(() => {
        expect(screen.getByText("Sync")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Sync"));

      await waitFor(() => {
        expect(screen.getByText("Device locked — unlock to sync Apple Health data")).toBeTruthy();
      });
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it("triggers Apple Health full sync with syncRangeDays: null when Full sync is clicked", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "apple_health" });
      mockProvidersQuery.mockReturnValue({ data: [authorizedProvider], isLoading: false });
      mockProviderStatsQuery.mockReturnValue({ data: [appleHealthStats], isLoading: false });
      mockSyncHealthKit.mockResolvedValue({ inserted: 12, errors: [] });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      await waitFor(() => {
        expect(screen.getByText("Full sync")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Full sync"));

      await waitFor(() => {
        expect(mockSyncHealthKit).toHaveBeenCalledWith(
          expect.objectContaining({ syncRangeDays: null }),
        );
      });
    });

    it("shows Connect for Apple Health when it was never authorized", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "apple_health" });
      mockProvidersQuery.mockReturnValue({ data: [authorizedProvider], isLoading: false });
      mockProviderStatsQuery.mockReturnValue({ data: [appleHealthStats], isLoading: false });
      mockHasEverAuthorized.mockReturnValue(false);
      mockGetRequestStatus.mockResolvedValue("shouldRequest");

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      await waitFor(() => {
        expect(screen.getByText("Connect")).toBeTruthy();
      });
      expect(screen.queryByText("Full sync")).toBeNull();
    });

    it("shows Sync for Apple Health when current HealthKit permissions are already authorized", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "apple_health" });
      mockProvidersQuery.mockReturnValue({ data: [authorizedProvider], isLoading: false });
      mockProviderStatsQuery.mockReturnValue({ data: [appleHealthStats], isLoading: false });
      mockHasEverAuthorized.mockReturnValue(false);
      mockGetRequestStatus.mockResolvedValue("unnecessary");

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      await waitFor(() => {
        expect(screen.getByText("Sync")).toBeTruthy();
      });
      expect(screen.getByText("Full sync")).toBeTruthy();
    });

    it("requests Apple Health permissions when Connect is clicked", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "apple_health" });
      mockProvidersQuery.mockReturnValue({ data: [authorizedProvider], isLoading: false });
      mockProviderStatsQuery.mockReturnValue({ data: [appleHealthStats], isLoading: false });
      mockHasEverAuthorized.mockReturnValue(false);
      mockGetRequestStatus.mockResolvedValue("shouldRequest");

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      await waitFor(() => {
        expect(screen.getByText("Connect")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Connect"));

      await waitFor(() => {
        expect(mockRequestPermissions).toHaveBeenCalled();
      });
    });

    it("shows denied Apple Health permissions separately from device unavailability", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "apple_health" });
      mockProvidersQuery.mockReturnValue({ data: [authorizedProvider], isLoading: false });
      mockProviderStatsQuery.mockReturnValue({ data: [appleHealthStats], isLoading: false });
      mockHasEverAuthorized.mockReturnValue(false);
      mockGetRequestStatus.mockResolvedValue("shouldRequest");
      mockRequestPermissions.mockResolvedValue(false);

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      await waitFor(() => {
        expect(screen.getByText("Connect")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Connect"));

      await waitFor(() => {
        expect(screen.getByText("Apple Health permissions were not granted")).toBeTruthy();
      });
    });
  });

  describe("Disconnect", () => {
    it("groups destructive actions in one danger zone with retained-data copy", async () => {
      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getAllByText("Danger Zone")).toHaveLength(1);
      expect(screen.getByText("Disconnect Wahoo")).toBeTruthy();
      expect(
        screen.getByText(
          "Disconnecting Wahoo removes its saved authorization and stops future syncs. Data already imported into Dofek is kept.",
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(
          "Permanently delete every Wahoo record from Dofek. This does not change whether Wahoo is connected.",
        ),
      ).toBeTruthy();
    });

    it("does not render disconnect button when provider is not authorized", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "strava" });
      mockProvidersQuery.mockReturnValue({ data: [unauthorizedProvider], isLoading: false });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.queryByText("Disconnect Strava")).toBeNull();
      expect(screen.getByText("Delete All Data")).toBeTruthy();
    });

    it("shows a provider-named confirmation with the safe action first", async () => {
      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByLabelText("Disconnect Wahoo"));

      expect(screen.getByText("Disconnect Wahoo?")).toBeTruthy();
      const actions = screen.getByLabelText("Cancel disconnect").parentElement;
      expect(actions?.firstElementChild).toBe(screen.getByLabelText("Cancel disconnect"));
      expect(screen.getByLabelText("Confirm disconnect Wahoo")).toBeTruthy();
    });

    it("disconnects once, invalidates provider state, and stays on the detail screen", async () => {
      mockDisconnectMutateAsync.mockResolvedValue({});

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByLabelText("Disconnect Wahoo"));
      const confirm = screen.getByLabelText("Confirm disconnect Wahoo");
      fireEvent.click(confirm);
      fireEvent.click(confirm);

      await waitFor(() => {
        expect(mockDisconnectMutateAsync).toHaveBeenCalledWith({ providerId: "wahoo" });
        expect(mockDisconnectMutateAsync).toHaveBeenCalledTimes(1);
        expect(mockInvalidateProviders).toHaveBeenCalled();
        expect(mockInvalidateProviderStats).toHaveBeenCalled();
        expect(mockBack).not.toHaveBeenCalled();
      });
    });

    it("shows the exact server disconnect error in the confirmation", async () => {
      mockDisconnectMutateAsync.mockRejectedValue(
        new Error("This provider is not connected to your account."),
      );

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByLabelText("Disconnect Wahoo"));
      fireEvent.click(screen.getByLabelText("Confirm disconnect Wahoo"));

      await waitFor(() => {
        expect(screen.getByText("This provider is not connected to your account.")).toBeTruthy();
        expect(mockCaptureException).toHaveBeenCalled();
      });
    });

    it("scopes pull-to-refresh to provider detail and provider metadata queries", async () => {
      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      const refreshOptions = mockUseRefresh.mock.calls.at(-1)?.[0];
      await refreshOptions?.invalidate?.();

      expect(mockInvalidateRecords).toHaveBeenCalledWith({ providerId: "wahoo" });
      expect(mockInvalidateAvailableDataTypes).toHaveBeenCalledWith({ providerId: "wahoo" });
      expect(mockInvalidateDetailLogs).toHaveBeenCalledWith({ providerId: "wahoo" });
      expect(mockInvalidateProviders).toHaveBeenCalled();
      expect(mockInvalidateProviderStats).toHaveBeenCalled();
      expect(mockInvalidateDataHealth).toHaveBeenCalled();
    });
  });

  describe("Delete all data", () => {
    it("requires typing DELETE before deleting provider records", async () => {
      mockDeleteAllDataMutateAsync.mockResolvedValue({
        success: true,
        operationId: "30000000-0000-4000-8000-000000000001",
      });
      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Delete All Data"));
      const confirmButton = screen.getByText("Permanently Delete Data").closest("button");
      if (!confirmButton) throw new Error("Delete confirmation button not found");
      expect(confirmButton).toHaveProperty("disabled", true);

      fireEvent.change(screen.getByPlaceholderText("DELETE"), { target: { value: "DELETE" } });
      fireEvent.click(confirmButton);

      await waitFor(() => {
        expect(mockDeleteAllDataMutateAsync).toHaveBeenCalledWith({
          providerId: "wahoo",
          confirmation: "DELETE",
        });
      });
    });
  });

  describe("Activity records", () => {
    it("exposes the active record type as a selected tab", async () => {
      mockAvailableDataTypesQuery.mockReturnValue({
        data: ["activities", "sleepSessions"],
        isLoading: false,
        isError: false,
        error: null,
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByRole("tablist", { name: "Record types" })).toBeTruthy();
      expect(screen.getByRole("tab", { name: "Activities" }).getAttribute("aria-selected")).toBe(
        "true",
      );
      expect(screen.getByRole("tab", { name: "Sleep" }).getAttribute("aria-selected")).toBe(
        "false",
      );
    });

    it("shows provider statistics failures while retaining known provider details", async () => {
      mockProviderStatsQuery.mockReturnValue({
        data: undefined,
        error: new Error("Provider statistics are temporarily unavailable"),
        isLoading: false,
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Wahoo")).toBeTruthy();
      expect(screen.getByText("Provider statistics are temporarily unavailable")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Sync" })).toBeTruthy();
    });

    it("exposes record detail disclosure state", async () => {
      mockRecordsQuery.mockReturnValue({
        data: {
          rows: [
            {
              id: "activity-123",
              name: "Morning Ride",
              notes: null,
              raw: { source: "wahoo" },
            },
          ],
        },
        isLoading: false,
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByRole("button", { name: "Open record Morning Ride" }));

      expect(
        screen.getByRole("button", { name: "Show empty fields" }).getAttribute("aria-expanded"),
      ).toBe("false");
      expect(
        screen
          .getByRole("button", { name: "Hide raw provider data" })
          .getAttribute("aria-expanded"),
      ).toBe("true");
    });

    it("shows canonical activity records while aggregate provider stats are catching up", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "kaya-export" });
      mockProvidersQuery.mockReturnValue({
        data: [{ ...importOnlyProvider, id: "kaya-export", name: "Kaya" }],
        isLoading: false,
      });
      mockProviderStatsQuery.mockReturnValue({ data: [], isLoading: false });
      mockRecordsQuery.mockReturnValue({
        data: { rows: [{ id: "activity-123", name: "Kaya climbing" }] },
        isLoading: false,
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Kaya climbing")).toBeTruthy();
      expect(screen.queryByText("No records yet for this provider.")).toBeNull();
    });

    it("shows the record availability query error", async () => {
      mockAvailableDataTypesQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
        error: new Error("Record availability is temporarily unavailable"),
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Record availability is temporarily unavailable")).toBeTruthy();
    });

    it("navigates from the record modal to the activity detail screen", async () => {
      mockProviderStatsQuery.mockReturnValue({
        data: [{ ...appleHealthStats, providerId: "wahoo", totalRecords: 1, activities: 1 }],
        isLoading: false,
      });
      mockRecordsQuery.mockReturnValue({
        data: { rows: [{ id: "activity-123", name: "Morning Ride" }] },
        isLoading: false,
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Morning Ride"));
      fireEvent.click(screen.getByText("Open activity"));

      expect(mockPush).toHaveBeenCalledWith("/activity/activity-123");
    });
  });

  describe("WhoopWearLocationPicker", () => {
    const whoopProvider = {
      id: "whoop",
      name: "WHOOP",
      authType: "oauth",
      authorized: true,
      importOnly: false,
      lastSyncedAt: "2026-03-19T12:00:00Z",
      needsReauth: false,
    };

    beforeEach(() => {
      mockUseLocalSearchParams.mockReturnValue({ id: "whoop" });
      mockProvidersQuery.mockReturnValue({ data: [whoopProvider], isLoading: false });
      mockProviderStatsQuery.mockReturnValue({ data: [], isLoading: false });
      mockRecordsQuery.mockReturnValue({ data: { rows: [] }, isLoading: false });
      mockLogsQuery.mockReturnValue({ data: [], isLoading: false });
      mockSettingsGetQuery.mockReturnValue({ data: null, isLoading: false });
      mockSettingsSetMutate.mockReset();
      mockSettingsGetGetData.mockReset();
      mockSettingsGetSetData.mockReset();
      mockSettingsGetInvalidate.mockReset();
      mockCaptureException.mockReset();
    });

    it("gives WHOOP one exact range and one sync action", async () => {
      mockSyncMutateAsync.mockResolvedValue({
        providerResults: [
          {
            providerId: "whoop",
            status: "skippedCooldown",
            message: "WHOOP sync is already current",
          },
        ],
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByRole("button", { name: "From" })).toBeTruthy();
      const toDatePicker = screen.getByRole("button", { name: "To" });
      expect(toDatePicker.getAttribute("data-maximum-time")).toBe(
        toDatePicker.getAttribute("data-value-time"),
      );
      expect(screen.getAllByRole("button", { name: "Sync" })).toHaveLength(1);
      expect(screen.queryByText("Full sync")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "From" }));
      fireEvent.click(screen.getByRole("button", { name: "To" }));
      fireEvent.click(screen.getByRole("button", { name: "Sync" }));

      await waitFor(() => {
        expect(mockSyncMutateAsync).toHaveBeenCalledWith({
          providerId: "whoop",
          sinceDate: "2026-06-01",
          untilDate: "2026-06-15",
        });
      });
    });

    it("does not start a WHOOP sync when its selected range is inverted", async () => {
      mockDatePickerSelections.From = new Date(2026, 5, 18, 12);
      mockDatePickerSelections.To = new Date(2026, 5, 17, 12);

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByRole("button", { name: "From" }));
      fireEvent.click(screen.getByRole("button", { name: "To" }));
      fireEvent.click(screen.getByRole("button", { name: "Sync" }));

      expect(screen.getByText('"From" date must be on or before "To" date')).toBeTruthy();
      expect(mockSyncMutateAsync).not.toHaveBeenCalled();

      mockDatePickerSelections.To = new Date(2026, 5, 19, 12);
      fireEvent.click(screen.getByRole("button", { name: "To" }));

      expect(screen.queryByText('"From" date must be on or before "To" date')).toBeNull();
    });

    it("renders wear location picker when providerId is whoop", async () => {
      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Wear Location")).toBeTruthy();
      expect(
        screen.getByText("Where do you wear your WHOOP? This helps us interpret your sensor data."),
      ).toBeTruthy();
    });

    it("renders all five wear location options", async () => {
      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Wrist")).toBeTruthy();
      expect(screen.getByText("Bicep / Upper Arm")).toBeTruthy();
      expect(screen.getByText("Chest / Torso")).toBeTruthy();
      expect(screen.getByText("Waist / Waistband")).toBeTruthy();
      expect(screen.getByText("Lower Leg / Calf")).toBeTruthy();
    });

    it("includes placement details in wear location accessible names", async () => {
      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(
        screen.getByRole("button", {
          name: "Wrist, Standard wrist band, ~1 inch above the wrist bone",
        }),
      ).toBeTruthy();
    });

    it("does not render wear location picker for non-whoop providers", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "wahoo" });
      mockProvidersQuery.mockReturnValue({ data: [authorizedProvider], isLoading: false });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(screen.queryByText("Wear Location")).toBeNull();
    });

    it("calls the settings mutation when a location is clicked", async () => {
      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Bicep / Upper Arm"));

      expect(mockSettingsSetMutate).toHaveBeenCalledWith(
        { key: "whoop.wearLocation", value: "bicep" },
        expect.objectContaining({
          onError: expect.any(Function),
          onSettled: expect.any(Function),
        }),
      );
    });

    it("optimistically updates the cache when a location is clicked", async () => {
      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Chest / Torso"));

      expect(mockSettingsGetSetData).toHaveBeenCalledWith(
        { key: "whoop.wearLocation" },
        { key: "whoop.wearLocation", value: "chest" },
      );
    });

    it("restores the exact cached location and displays the server error when a write fails", async () => {
      const previousSetting = { key: "whoop.wearLocation", value: "bicep" };
      mockSettingsGetQuery.mockReturnValue({
        data: previousSetting,
        error: null,
        isLoading: false,
      });
      mockSettingsGetGetData.mockReturnValue(previousSetting);
      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Chest / Torso"));
      const options = mockSettingsSetMutate.mock.calls[0]?.[1];
      const writeError = new Error("Wear location was not saved.");
      act(() => options.onError(writeError));
      act(() => options.onSettled());

      expect(mockSettingsGetSetData).toHaveBeenLastCalledWith(
        { key: "whoop.wearLocation" },
        previousSetting,
      );
      expect(mockSettingsGetInvalidate).toHaveBeenCalledWith({ key: "whoop.wearLocation" });
      expect(screen.getByText(writeError.message)).toBeTruthy();
      expect(mockCaptureException).toHaveBeenCalledWith(writeError, {
        context: "whoop-wear-location-write",
      });
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
    });

    it("keeps cached location visible and displays an exact background read error", async () => {
      const readError = new Error("Wear location could not be loaded.");
      mockSettingsGetQuery.mockReturnValue({
        data: { key: "whoop.wearLocation", value: "bicep" },
        error: readError,
        isLoading: false,
      });

      const { default: ProviderDetailScreen } = await import("../../app/providers/[id]");
      render(<ProviderDetailScreen />);

      expect(
        screen
          .getByRole("button", {
            name: "Bicep / Upper Arm, Bicep band, arm sleeve, or impact sleeve",
          })
          .getAttribute("aria-selected"),
      ).toBe("true");
      expect(screen.getByText(readError.message)).toBeTruthy();
      await waitFor(() =>
        expect(mockCaptureException).toHaveBeenCalledWith(readError, {
          context: "whoop-wear-location-read",
        }),
      );
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
    });
  });
});
