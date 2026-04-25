// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAlertFn = vi.fn();
const mockOpenBrowserAsync = vi.fn();
const mockGetRequestStatus = vi.fn().mockResolvedValue("unnecessary");
const mockHasEverAuthorized = vi.fn().mockReturnValue(true);
const mockRequestPermissions = vi.fn().mockResolvedValue(true);
const mockSyncHealthKit = vi.fn();

vi.mock("react-native", () => ({
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
      ...rest
    } = props;
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
    const { style: _s, activeOpacity: _ao, ...rest } = props;
    return React.createElement(
      "button",
      { type: "button", onClick: onPress, disabled, ...rest },
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
    const { animationType: _at, transparent: _t, presentationStyle: _ps, ...rest } = props;
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
const mockUseLocalSearchParams = vi.fn().mockReturnValue({ id: "wahoo" });

vi.mock("expo-router", () => ({
  useRouter: () => ({ back: mockBack, push: vi.fn(), replace: vi.fn() }),
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
}));

vi.mock("../../lib/auth-context", () => ({
  useAuth: () => ({
    serverUrl: "https://test.example.com",
    sessionToken: "test-token",
  }),
}));

vi.mock("@dofek/format/format", () => ({
  formatRelativeTime: (date: string) => `${date} ago`,
  formatTime: (date: string) => date,
}));

const mockProvidersQuery = vi.fn();
const mockProviderStatsQuery = vi.fn();
const mockRecordsQuery = vi.fn();
const mockLogsQuery = vi.fn();
const mockSyncMutateAsync = vi.fn();
const mockDisconnectMutateAsync = vi.fn();
const mockInvalidateProviders = vi.fn();
const mockInvalidateProviderStats = vi.fn();
const mockInvalidateLogs = vi.fn();
const mockSyncStatusFetch = vi.fn();
const mockSettingsGetQuery = vi.fn().mockReturnValue({ data: null, isLoading: false });
const mockSettingsSetMutate = vi.fn();
const mockSettingsGetSetData = vi.fn();
const mockSettingsGetInvalidate = vi.fn();

vi.mock("../../lib/trpc", () => ({
  trpc: {
    sync: {
      providers: { useQuery: (...args: unknown[]) => mockProvidersQuery(...args) },
      providerStats: { useQuery: (...args: unknown[]) => mockProviderStatsQuery(...args) },
      triggerSync: {
        useMutation: () => ({ mutateAsync: mockSyncMutateAsync, isPending: false }),
      },
    },
    providerDetail: {
      records: { useQuery: (...args: unknown[]) => mockRecordsQuery(...args) },
      logs: { useQuery: (...args: unknown[]) => mockLogsQuery(...args) },
      disconnect: {
        useMutation: () => ({ mutateAsync: mockDisconnectMutateAsync, isPending: false }),
      },
    },
    settings: {
      get: { useQuery: (...args: unknown[]) => mockSettingsGetQuery(...args) },
      set: { useMutation: () => ({ mutate: mockSettingsSetMutate, isPending: false }) },
    },
    useUtils: () => ({
      client: {},
      invalidate: vi.fn(),
      sync: {
        providers: { invalidate: mockInvalidateProviders },
        providerStats: { invalidate: mockInvalidateProviderStats },
        logs: { invalidate: mockInvalidateLogs },
        syncStatus: { fetch: mockSyncStatusFetch },
      },
      settings: {
        get: { setData: mockSettingsGetSetData, invalidate: mockSettingsGetInvalidate },
      },
    }),
  },
}));

vi.mock("../../modules/health-kit", () => ({
  getRequestStatus: (...args: unknown[]) => mockGetRequestStatus(...args),
  hasEverAuthorized: (...args: unknown[]) => mockHasEverAuthorized(...args),
  isAvailable: () => true,
  queryDailyStatistics: vi.fn(),
  queryQuantitySamples: vi.fn(),
  querySleepSamples: vi.fn(),
  queryWorkoutRoutes: vi.fn(),
  queryWorkouts: vi.fn(),
  requestPermissions: (...args: unknown[]) => mockRequestPermissions(...args),
}));

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
  needsOAuth: false,
};

const unauthorizedProvider = {
  id: "strava",
  name: "Strava",
  authType: "oauth",
  authorized: false,
  importOnly: false,
  lastSyncedAt: null,
  needsOAuth: false,
};

const importOnlyProvider = {
  id: "strong-csv",
  name: "Strong",
  authType: "none",
  authorized: true,
  importOnly: true,
  lastSyncedAt: null,
  needsOAuth: false,
};

const appleHealthStats = {
  providerId: "apple_health",
  activities: 0,
  bodyMetrics: 0,
  dailyMetrics: 0,
  sleepSessions: 0,
  workouts: 0,
};

function setupDefaultMocks() {
  mockProvidersQuery.mockReturnValue({ data: [authorizedProvider], isLoading: false });
  mockProviderStatsQuery.mockReturnValue({ data: [], isLoading: false });
  mockRecordsQuery.mockReturnValue({ data: { rows: [] }, isLoading: false });
  mockLogsQuery.mockReturnValue({ data: [], isLoading: false });
}

describe("ProviderDetailScreen", () => {
  beforeEach(() => {
    mockBack.mockReset();
    mockUseLocalSearchParams.mockReturnValue({ id: "wahoo" });
    mockSyncMutateAsync.mockReset();
    mockDisconnectMutateAsync.mockReset();
    mockInvalidateProviders.mockReset();
    mockInvalidateProviderStats.mockReset();
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
    mockAlertFn.mockReset();
    setupDefaultMocks();
  });

  describe("Actions", () => {
    it("renders Sync and Full sync actions for connected providers", async () => {
      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Sync")).toBeTruthy();
      expect(screen.getByText("Full sync")).toBeTruthy();
      expect(screen.queryByText("Sync Range")).toBeNull();
    });

    it("renders Connect action for disconnected providers", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "strava" });
      mockProvidersQuery.mockReturnValue({ data: [unauthorizedProvider], isLoading: false });

      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Connect")).toBeTruthy();
      expect(screen.queryByText("Sync")).toBeNull();
      expect(screen.queryByText("Full sync")).toBeNull();
    });

    it("does not render actions for import-only providers", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "strong-csv" });
      mockProvidersQuery.mockReturnValue({ data: [importOnlyProvider], isLoading: false });

      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      expect(screen.queryByText("Connect")).toBeNull();
      expect(screen.queryByText("Sync")).toBeNull();
      expect(screen.queryByText("Full sync")).toBeNull();
    });

    it("triggers generic provider sync with sinceDays=7 when Sync is clicked", async () => {
      mockSyncMutateAsync.mockResolvedValue({ jobId: "job-1" });
      mockSyncStatusFetch.mockResolvedValue({
        status: "done",
        percentage: 100,
        providers: { wahoo: { status: "done", message: "Done" } },
      });

      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Sync"));

      await waitFor(() => {
        expect(mockSyncMutateAsync).toHaveBeenCalledWith({
          providerId: "wahoo",
          sinceDays: 7,
        });
      });
    });

    it("triggers generic provider full sync when Full sync is clicked", async () => {
      mockSyncMutateAsync.mockResolvedValue({ jobId: "job-2" });
      mockSyncStatusFetch.mockResolvedValue({
        status: "done",
        percentage: 100,
        providers: { wahoo: { status: "done", message: "Done" } },
      });

      const { default: ProviderDetailScreen } = await import("./[id]");
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

      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      await waitFor(() => {
        expect(screen.getByText("Connect")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Connect"));

      await waitFor(() => {
        expect(mockOpenBrowserAsync).toHaveBeenCalledWith(
          "https://test.example.com/auth/provider/strava?session=test-token",
        );
      });
    });

    it("triggers Apple Health sync with syncRangeDays: 7 when Sync is clicked", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "apple_health" });
      mockProvidersQuery.mockReturnValue({ data: [authorizedProvider], isLoading: false });
      mockProviderStatsQuery.mockReturnValue({ data: [appleHealthStats], isLoading: false });
      mockSyncHealthKit.mockResolvedValue({ inserted: 12, errors: [] });

      const { default: ProviderDetailScreen } = await import("./[id]");
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

    it("triggers Apple Health full sync with syncRangeDays: null when Full sync is clicked", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "apple_health" });
      mockProvidersQuery.mockReturnValue({ data: [authorizedProvider], isLoading: false });
      mockProviderStatsQuery.mockReturnValue({ data: [appleHealthStats], isLoading: false });
      mockSyncHealthKit.mockResolvedValue({ inserted: 12, errors: [] });

      const { default: ProviderDetailScreen } = await import("./[id]");
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

      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      await waitFor(() => {
        expect(screen.getByText("Connect")).toBeTruthy();
      });
      expect(screen.queryByText("Full sync")).toBeNull();
    });

    it("requests Apple Health permissions when Connect is clicked", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "apple_health" });
      mockProvidersQuery.mockReturnValue({ data: [authorizedProvider], isLoading: false });
      mockProviderStatsQuery.mockReturnValue({ data: [appleHealthStats], isLoading: false });
      mockHasEverAuthorized.mockReturnValue(false);

      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      await waitFor(() => {
        expect(screen.getByText("Connect")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Connect"));

      await waitFor(() => {
        expect(mockRequestPermissions).toHaveBeenCalled();
      });
    });
  });

  describe("Disconnect", () => {
    it("renders disconnect button when provider is authorized", async () => {
      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Disconnect Provider")).toBeTruthy();
    });

    it("does not render disconnect button when provider is not authorized", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "strava" });
      mockProvidersQuery.mockReturnValue({ data: [unauthorizedProvider], isLoading: false });

      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      expect(screen.queryByText("Disconnect Provider")).toBeNull();
    });

    it("shows Alert.alert with correct title when disconnect button is clicked", async () => {
      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Disconnect Provider"));

      expect(mockAlertFn).toHaveBeenCalledWith(
        "Disconnect Provider",
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ text: "Cancel", style: "cancel" }),
          expect.objectContaining({ text: "Disconnect", style: "destructive" }),
        ]),
      );
    });

    it("calls disconnect mutation and navigates back when confirmed", async () => {
      mockDisconnectMutateAsync.mockResolvedValue({});

      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Disconnect Provider"));

      const alertCall = mockAlertFn.mock.calls[0];
      if (!alertCall) throw new Error("Disconnect alert was not shown");
      const buttons: Array<{
        text: string;
        style: string;
        onPress?: () => Promise<void>;
      }> = alertCall[2];
      const disconnectButton = buttons.find((b) => b.text === "Disconnect");
      expect(disconnectButton).toBeDefined();
      if (!disconnectButton) throw new Error("Disconnect button not found");

      await disconnectButton.onPress?.();

      await waitFor(() => {
        expect(mockDisconnectMutateAsync).toHaveBeenCalledWith({ providerId: "wahoo" });
        expect(mockBack).toHaveBeenCalled();
      });
    });

    it("invalidates providers and providerStats after successful disconnect", async () => {
      mockDisconnectMutateAsync.mockResolvedValue({});

      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Disconnect Provider"));

      const alertCall = mockAlertFn.mock.calls[0];
      if (!alertCall) throw new Error("Disconnect alert was not shown");
      const buttons: Array<{
        text: string;
        style: string;
        onPress?: () => Promise<void>;
      }> = alertCall[2];
      const disconnectButton = buttons.find((b) => b.text === "Disconnect");
      if (!disconnectButton) throw new Error("Disconnect button not found");

      await disconnectButton.onPress?.();

      await waitFor(() => {
        expect(mockInvalidateProviders).toHaveBeenCalled();
        expect(mockInvalidateProviderStats).toHaveBeenCalled();
      });
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
      needsOAuth: false,
    };

    beforeEach(() => {
      mockUseLocalSearchParams.mockReturnValue({ id: "whoop" });
      mockProvidersQuery.mockReturnValue({ data: [whoopProvider], isLoading: false });
      mockProviderStatsQuery.mockReturnValue({ data: [], isLoading: false });
      mockRecordsQuery.mockReturnValue({ data: { rows: [] }, isLoading: false });
      mockLogsQuery.mockReturnValue({ data: [], isLoading: false });
      mockSettingsGetQuery.mockReturnValue({ data: null, isLoading: false });
      mockSettingsSetMutate.mockReset();
      mockSettingsGetSetData.mockReset();
      mockSettingsGetInvalidate.mockReset();
    });

    it("renders wear location picker when providerId is whoop", async () => {
      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Wear Location")).toBeTruthy();
      expect(
        screen.getByText("Where do you wear your WHOOP? This helps us interpret your sensor data."),
      ).toBeTruthy();
    });

    it("renders all five wear location options", async () => {
      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      expect(screen.getByText("Wrist")).toBeTruthy();
      expect(screen.getByText("Bicep / Upper Arm")).toBeTruthy();
      expect(screen.getByText("Chest / Torso")).toBeTruthy();
      expect(screen.getByText("Waist / Waistband")).toBeTruthy();
      expect(screen.getByText("Lower Leg / Calf")).toBeTruthy();
    });

    it("does not render wear location picker for non-whoop providers", async () => {
      mockUseLocalSearchParams.mockReturnValue({ id: "wahoo" });
      mockProvidersQuery.mockReturnValue({ data: [authorizedProvider], isLoading: false });

      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      expect(screen.queryByText("Wear Location")).toBeNull();
    });

    it("calls the settings mutation when a location is clicked", async () => {
      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Bicep / Upper Arm"));

      expect(mockSettingsSetMutate).toHaveBeenCalledWith(
        { key: "whoop.wearLocation", value: "bicep" },
        expect.objectContaining({ onSettled: expect.any(Function) }),
      );
    });

    it("optimistically updates the cache when a location is clicked", async () => {
      const { default: ProviderDetailScreen } = await import("./[id]");
      render(<ProviderDetailScreen />);

      fireEvent.click(screen.getByText("Chest / Torso"));

      expect(mockSettingsGetSetData).toHaveBeenCalledWith(
        { key: "whoop.wearLocation" },
        { key: "whoop.wearLocation", value: "chest" },
      );
    });
  });
});
