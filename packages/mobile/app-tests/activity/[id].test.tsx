// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { Alert } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureException } from "../../lib/telemetry";

function stripStyle({
  style: _s,
  contentContainerStyle: _cs,
  scrollEnabled: _se,
  ...rest
}: Record<string, unknown>) {
  return rest;
}

vi.mock("react-native", () => ({
  View: ({ children, accessibilityLabel, ...props }: Record<string, unknown>) =>
    React.createElement(
      "div",
      stripStyle({ ...props, "aria-label": accessibilityLabel }),
      ...(children != null ? [children] : []),
    ),
  Text: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("span", stripStyle(props), ...(children != null ? [children] : [])),
  ScrollView: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", stripStyle(props), ...(children != null ? [children] : [])),
  Pressable: ({
    accessibilityLabel,
    accessibilityRole,
    children,
    onPress,
    ...props
  }: Record<string, unknown>) =>
    React.createElement(
      "button",
      {
        ...stripStyle(props),
        type: "button",
        onClick: onPress,
        "aria-label": accessibilityLabel,
        role: accessibilityRole,
      },
      ...(children != null ? [children] : []),
    ),
  ActivityIndicator: () => React.createElement("div", { "data-testid": "loading" }),
  Alert: { alert: vi.fn() },
  Modal: ({ children, visible }: Record<string, unknown>) =>
    visible ? React.createElement("div", { "data-testid": "modal" }, children) : null,
  Linking: { openURL: vi.fn() },
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => {
      for (const key of Object.keys(styles)) {
        styles[key] = {};
      }
      return styles;
    },
    hairlineWidth: 1,
  },
}));

vi.mock("react-native-svg", () => ({
  __esModule: true,
  default: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("svg", props, ...(children != null ? [children] : [])),
  Circle: (props: Record<string, unknown>) => React.createElement("circle", props),
  Defs: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("defs", props, ...(children != null ? [children] : [])),
  G: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("g", props, ...(children != null ? [children] : [])),
  Line: (props: Record<string, unknown>) => React.createElement("line", props),
  LinearGradient: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("linearGradient", props, ...(children != null ? [children] : [])),
  Path: (props: Record<string, unknown>) => React.createElement("path", props),
  Polyline: (props: Record<string, unknown>) => React.createElement("polyline", props),
  Rect: (props: Record<string, unknown>) => React.createElement("rect", props),
  Stop: (props: Record<string, unknown>) => React.createElement("stop", props),
  Text: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("text", props, ...(children != null ? [children] : [])),
}));

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "00000000-0000-0000-0000-000000000001" }),
  useRouter: () => ({ back: vi.fn() }),
}));

vi.mock("../../components/ChartTitleWithTooltip", () => ({
  ChartTitleWithTooltip: ({ title }: { title: string }) => React.createElement("span", null, title),
}));

vi.mock("../../components/MuscleGroupBodyDiagram", () => ({
  MuscleGroupBodyDiagram: () => null,
}));

vi.mock("../../components/RouteMap", () => ({
  RouteMap: () => null,
}));

vi.mock("../../app/activity/useChartScrub", () => ({
  useChartScrub: () => ({
    touchIndex: null,
    panResponder: { panHandlers: {} },
  }),
}));

vi.mock("../../lib/units", () => ({
  useUnitConverter: () => ({
    convertDistance: (km: number) => km,
    distanceLabel: "km",
    convertSpeed: (speed: number) => speed,
    speedLabel: "km/h",
    convertElevation: (elevation: number) => elevation,
    elevationLabel: "m",
    convertWeight: (kg: number) => kg,
    weightLabel: "kg",
  }),
}));

vi.mock("../../lib/auth-context", () => ({
  useAuth: () => ({
    serverUrl: "https://example.com",
    sessionToken: "test-session-token",
  }),
}));

vi.mock("../../lib/activity-export", () => ({
  downloadActivityExport: vi.fn(),
}));

vi.mock("../../lib/telemetry", () => ({
  captureException: vi.fn(),
}));

vi.mock("../../theme", () => ({
  colors: {
    background: "#000",
    surface: "#111",
    surfaceSecondary: "#1a1a1a",
    text: "#fff",
    textSecondary: "#aaa",
    textTertiary: "#666",
    blue: "#00f",
    warning: "#f90",
    accent: "#00f",
    positive: "#0f0",
    danger: "#f00",
  },
  radius: { md: 8, xl: 16, full: 999 },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24 },
}));

vi.mock("@dofek/format/format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dofek/format/format")>();
  return {
    ...actual,
    formatDateLong: (value: string) => (value.startsWith("2026-03-05") ? "March 5, 2026" : value),
    formatDateTime: (value: string) =>
      value.startsWith("2026-03-05") ? "March 5, 2026, 2:30 PM" : value,
    formatDurationRange: () => "1:00:00",
    formatDurationSeconds: (value: number) => `${value}s`,
    formatNumber: (value: number) => String(value),
    formatTimeOnly: (value: string) => value,
  };
});

vi.mock("@dofek/format/units", () => ({}));

vi.mock("@dofek/providers/providers", () => ({
  providerLabel: (id: string) => (id === "strava" ? "Strava" : id),
  providerSourceLabel: (id: string, subsource?: string | null) =>
    id === "apple_health" && subsource
      ? `${subsource} (via Apple Health)`
      : id === "strava"
        ? "Strava"
        : id,
  providerAbsentExplanation: (id: string, subsource?: string | null) => {
    if (id === "apple_health" && subsource) {
      return `The Apple Health copy of this workout (originally from ${subsource}) was removed from sync. This does not mean ${subsource} deleted the activity.`;
    }
    const label = id === "apple_health" ? "Apple Health" : id === "strava" ? "Strava" : id;
    return `This activity was hidden because ${label} reported it as deleted or missing.`;
  },
}));

vi.mock("@dofek/scoring/colors", () => ({
  activityMetricColors: { heartRate: "red", power: "orange" },
  chartColors: { teal: "#0ea5e9", purple: "#5E35B1" },
  statusColors: {
    positive: "#16a34a",
    warning: "#ca8a04",
    danger: "#dc2626",
    info: "#2563eb",
    elevated: "#ea580c",
  },
  operationalStatusColors: {
    danger: { surface: "#fee2e2", border: "#dc2626", foreground: "#991b1b" },
  },
  textColors: { neutral: "#8aaa8a" },
}));

vi.mock("@dofek/training/muscle-groups", () => ({}));

vi.mock("@dofek/training/training", () => ({
  formatActivityTypeLabel: (type: string) => type,
  isCyclingActivity: (type: string) => type === "cycling",
  cadenceUnit: (type: string) => (type === "cycling" ? "rpm" : "steps/min"),
}));

vi.mock("@dofek/zones/zones", async () => {
  const actual = await vi.importActual<typeof import("@dofek/zones/zones")>("@dofek/zones/zones");
  return {
    ...actual,
    HEART_RATE_ZONE_COLORS: ["green", "lime", "yellow", "orange", "red"],
    POWER_ZONE_COLORS: [
      "#0ea5e9",
      "#2563eb",
      "#16a34a",
      "#ca8a04",
      "#ea580c",
      "#dc2626",
      "#5E35B1",
    ],
  };
});

const mockByIdQuery = vi.fn();
const mockStreamQuery = vi.fn();
const mockHrZonesQuery = vi.fn();
const mockPowerZonesQuery = vi.fn();
const mockStrengthExercisesQuery = vi.fn();
const mockClimbingEntriesQuery = vi.fn();
const mockHangboardDetailsQuery = vi.fn();
const mockRecomputeMutate = vi.fn();
const mockRecomputeShouldFail = vi.fn(() => false);
const mockActivityByIdInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityStreamInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityHrZonesInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityPowerZonesInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityStrengthExercisesInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityHangboardDetailsInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityListInvalidate = vi.fn().mockResolvedValue(undefined);
const mockCalendarWeekListInvalidate = vi.fn().mockResolvedValue(undefined);
const mockCalendarActivityOverviewInvalidate = vi.fn().mockResolvedValue(undefined);
const mockPerceivedExertionMutate = vi.fn();

vi.mock("../../lib/trpc", () => ({
  trpc: {
    activity: {
      byId: { useQuery: (...args: unknown[]) => mockByIdQuery(...args) },
      stream: { useQuery: (...args: unknown[]) => mockStreamQuery(...args) },
      hrZones: { useQuery: (...args: unknown[]) => mockHrZonesQuery(...args) },
      powerZones: { useQuery: (...args: unknown[]) => mockPowerZonesQuery(...args) },
      strengthExercises: { useQuery: (...args: unknown[]) => mockStrengthExercisesQuery(...args) },
      hangboardDetails: { useQuery: (...args: unknown[]) => mockHangboardDetailsQuery(...args) },
      recompute: {
        useMutation: (options?: {
          onSuccess?: () => Promise<void>;
          onError?: (error: Error) => void;
        }) => ({
          mutate: (input: { id: string }) => {
            mockRecomputeMutate(input);
            if (mockRecomputeShouldFail()) {
              options?.onError?.(new Error("Network unavailable"));
              return;
            }
            void options?.onSuccess?.();
          },
          isPending: false,
        }),
      },
      delete: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      setPerceivedExertion: {
        useMutation: () => ({ mutate: mockPerceivedExertionMutate, isPending: false, error: null }),
      },
    },
    climbing: {
      activityEntries: { useQuery: (...args: unknown[]) => mockClimbingEntriesQuery(...args) },
    },
    useUtils: () => ({
      activity: {
        byId: { invalidate: mockActivityByIdInvalidate },
        stream: { invalidate: mockActivityStreamInvalidate },
        hrZones: { invalidate: mockActivityHrZonesInvalidate },
        powerZones: { invalidate: mockActivityPowerZonesInvalidate },
        strengthExercises: { invalidate: mockActivityStrengthExercisesInvalidate },
        hangboardDetails: { invalidate: mockActivityHangboardDetailsInvalidate },
        list: { invalidate: mockActivityListInvalidate },
      },
      calendar: {
        weekList: { invalidate: mockCalendarWeekListInvalidate },
        activityOverview: { invalidate: mockCalendarActivityOverviewInvalidate },
      },
    }),
  },
}));

const baseCyclingActivity = {
  id: "00000000-0000-0000-0000-000000000001",
  activityType: "cycling",
  startedAt: "2026-04-14T10:00:00.000Z",
  endedAt: "2026-04-14T11:00:00.000Z",
  localTimeContext: {
    timezone: "America/Los_Angeles",
    startUtcOffsetMinutes: -420,
    endUtcOffsetMinutes: -420,
    source: "provider_timezone",
  },
  name: "Morning Ride",
  notes: null,
  perceivedExertion: null,
  providerId: "wahoo",
  subsource: null,
  sourceProviders: ["wahoo"],
  sourceLinks: [],
  sourceDecision: null,
  avgHr: 145,
  avgHrState: { status: "available" },
  maxHr: 172,
  maxHrState: { status: "available" },
  avgPower: 220,
  avgPowerState: { status: "available" },
  maxPower: 350,
  maxPowerState: { status: "available" },
  avgSpeed: 30,
  avgSpeedState: { status: "available" },
  maxSpeed: 50,
  maxSpeedState: { status: "available" },
  avgCadence: 88,
  avgCadenceState: { status: "available" },
  totalDistance: 30000,
  totalDistanceState: { status: "available" },
  elevationGain: 400,
  elevationGainState: { status: "available" },
  elevationLoss: 380,
  elevationLossState: { status: "available" },
  sampleCount: 200,
  sampleCountState: { status: "available" },
};

const streamPointsWithHrAndPower = Array.from({ length: 5 }, (_, index) => ({
  recordedAt: `2026-04-14T10:0${index}:00.000Z`,
  heartRate: 140 + index,
  power: 210 + index * 5,
  speed: 8.0 + index * 0.1,
  cadence: 87 + index,
  altitude: 100 + index * 2,
  lat: null,
  lng: null,
}));

function getQueryEnabledFlag(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const enabled = Reflect.get(value, "enabled");
  return typeof enabled === "boolean" ? enabled : undefined;
}

function getPlaceholderData(value: unknown): ((previousData: unknown) => unknown) | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const placeholderData = Reflect.get(value, "placeholderData");
  return typeof placeholderData === "function" ? placeholderData : undefined;
}

beforeEach(() => {
  mockByIdQuery.mockClear();
  mockStreamQuery.mockClear();
  mockHrZonesQuery.mockClear();
  mockPowerZonesQuery.mockClear();
  mockStrengthExercisesQuery.mockClear();
  mockClimbingEntriesQuery.mockClear();
  mockHangboardDetailsQuery.mockClear();
  mockRecomputeMutate.mockClear();
  mockRecomputeShouldFail.mockReset();
  mockRecomputeShouldFail.mockReturnValue(false);
  mockActivityByIdInvalidate.mockClear();
  mockActivityStreamInvalidate.mockClear();
  mockActivityHrZonesInvalidate.mockClear();
  mockActivityPowerZonesInvalidate.mockClear();
  mockActivityStrengthExercisesInvalidate.mockClear();
  mockActivityHangboardDetailsInvalidate.mockClear();
  mockActivityListInvalidate.mockClear();
  mockCalendarWeekListInvalidate.mockClear();
  mockCalendarActivityOverviewInvalidate.mockClear();
  mockPerceivedExertionMutate.mockClear();
  vi.mocked(Alert.alert).mockClear();
  vi.mocked(captureException).mockClear();
  mockByIdQuery.mockReturnValue({ data: baseCyclingActivity, isLoading: false, error: null });
  mockStreamQuery.mockReturnValue({ data: streamPointsWithHrAndPower, isLoading: false });
  mockHrZonesQuery.mockReturnValue({ data: [], isLoading: false, error: null });
  mockPowerZonesQuery.mockReturnValue({ data: null, isLoading: false });
  mockStrengthExercisesQuery.mockReturnValue({ data: [], isLoading: false });
  mockClimbingEntriesQuery.mockReturnValue({ data: [], isLoading: false });
  mockHangboardDetailsQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
});

describe("ActivityDetailScreen", () => {
  it("recomputes the activity and invalidates detail caches", async () => {
    let finishByIdInvalidation: () => void = () => {};
    const byIdInvalidation = new Promise<void>((resolve) => {
      finishByIdInvalidation = resolve;
    });
    mockActivityByIdInvalidate.mockReturnValueOnce(byIdInvalidation);
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    fireEvent.click(screen.getByText("Recompute"));

    const activityId = "00000000-0000-0000-0000-000000000001";
    expect(mockRecomputeMutate).toHaveBeenCalledWith({ id: activityId });
    await waitFor(() => {
      expect(mockActivityByIdInvalidate).toHaveBeenCalledWith({ id: activityId });
    });
    expect(mockActivityStreamInvalidate).toHaveBeenCalledWith({
      id: activityId,
      maxPoints: 200,
    });
    expect(mockActivityHrZonesInvalidate).toHaveBeenCalledWith({ id: activityId });
    expect(mockActivityPowerZonesInvalidate).toHaveBeenCalledWith({ id: activityId });
    expect(mockActivityStrengthExercisesInvalidate).toHaveBeenCalledWith({ id: activityId });
    expect(mockActivityHangboardDetailsInvalidate).toHaveBeenCalledWith({ id: activityId });
    expect(mockActivityListInvalidate).toHaveBeenCalled();
    expect(mockCalendarWeekListInvalidate).toHaveBeenCalled();
    expect(mockCalendarActivityOverviewInvalidate).toHaveBeenCalled();
    expect(screen.getByText("Recomputing...")).toBeTruthy();
    finishByIdInvalidation();
    await waitFor(() => {
      expect(screen.getByText("Recompute")).toBeTruthy();
    });
  });

  it("reports recompute failures and shows the server error", async () => {
    mockRecomputeShouldFail.mockReturnValue(true);
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    fireEvent.click(screen.getByText("Recompute"));

    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
    expect(Alert.alert).toHaveBeenCalledWith("Recompute Failed", "Network unavailable");
  });

  it("keeps previous stream and zone data visible while refetching", async () => {
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    const previousStream = [{ recordedAt: "2026-04-14T10:00:00.000Z" }];
    const previousZones = [{ zone: 1, seconds: 120 }];

    expect(getPlaceholderData(mockStreamQuery.mock.calls[0]?.[1])?.(previousStream)).toBe(
      previousStream,
    );
    expect(getPlaceholderData(mockHrZonesQuery.mock.calls[0]?.[1])?.(previousZones)).toBe(
      previousZones,
    );
  });

  it("renders without crashing when stream has heart rate and power data", async () => {
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));
    expect(screen.getByText("Morning Ride")).toBeTruthy();
  });

  it("enables Hangboarding details only for canonical hangboard activities", async () => {
    mockByIdQuery.mockReturnValue({
      data: { ...baseCyclingActivity, activityType: "cycling" },
      isLoading: false,
      error: null,
    });
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));
    expect(getQueryEnabledFlag(mockHangboardDetailsQuery.mock.calls[0]?.[1])).toBe(false);

    mockByIdQuery.mockReturnValue({
      data: { ...baseCyclingActivity, activityType: "hangboard", name: "Repeaters" },
      isLoading: false,
      error: null,
    });
    mockHangboardDetailsQuery.mockReturnValue({
      data: {
        planName: "Imported 7/3",
        sessionId: "session-1",
        boardId: "board-1",
        boardName: "Tension Board",
        segmentsError: null,
        intervals: [],
      },
      isLoading: false,
      error: null,
    });
    const rerendered = render(React.createElement(ActivityDetailScreen));
    rerendered.rerender(React.createElement(ActivityDetailScreen));
    expect(getQueryEnabledFlag(mockHangboardDetailsQuery.mock.calls.at(-1)?.[1])).toBe(true);
    expect(screen.getByText("Hangboarding")).toBeTruthy();
    expect(screen.getByText("Imported 7/3")).toBeTruthy();
  });

  it("renders server-authored detail state when a metric is unavailable without GPS", async () => {
    mockByIdQuery.mockReturnValue({
      data: {
        ...baseCyclingActivity,
        totalDistance: null,
        totalDistanceState: { status: "missing", reason: "Distance not recorded" },
      },
      isLoading: false,
      error: null,
    });
    mockStreamQuery.mockReturnValue({ data: [], isLoading: false });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText("Distance unavailable")).toBeTruthy();
    expect(screen.getByText("Distance not recorded")).toBeTruthy();
    expect(screen.getByLabelText("Distance unavailable: Distance not recorded")).toBeTruthy();
  });

  it("renders reasons for every unavailable activity metric state", async () => {
    mockByIdQuery.mockReturnValue({
      data: {
        ...baseCyclingActivity,
        totalDistance: null,
        totalDistanceState: { status: "processing", reason: "Distance is being recomputed" },
        elevationGain: null,
        elevationGainState: { status: "failed", reason: "Elevation processing failed" },
        avgHr: null,
        avgHrState: { status: "conflicting", reason: "Heart-rate sources disagree" },
      },
      isLoading: false,
      error: null,
    });
    mockStreamQuery.mockReturnValue({ data: [], isLoading: false });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText("Distance processing")).toBeTruthy();
    expect(screen.getByText("Distance is being recomputed")).toBeTruthy();
    expect(screen.getByText("Elevation Gain failed")).toBeTruthy();
    expect(screen.getByText("Elevation processing failed")).toBeTruthy();
    expect(screen.getByText("Avg Heart Rate conflicting")).toBeTruthy();
    expect(screen.getByText("Heart-rate sources disagree")).toBeTruthy();
  });

  it("preserves a server-provided zero detail distance without GPS", async () => {
    mockByIdQuery.mockReturnValue({
      data: {
        ...baseCyclingActivity,
        totalDistance: 0,
        totalDistanceState: { status: "available" },
      },
      isLoading: false,
      error: null,
    });
    mockStreamQuery.mockReturnValue({ data: [], isLoading: false });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText("0 km")).toBeTruthy();
    expect(screen.queryByText("Distance unavailable")).toBeNull();
  });

  it("surfaces the activity detail server error", async () => {
    mockByIdQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Activity detail is temporarily unavailable"),
    });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText("Activity detail is temporarily unavailable")).toBeTruthy();
  });

  it("uses layman-readable accessible names for activity export formats", async () => {
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    fireEvent.click(screen.getByRole("button", { name: "Export Activity" }));

    expect(screen.getByRole("button", { name: "Export as GPS track (GPX)" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export as Training Center data (TCX)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export as comma-separated values (CSV)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export as fitness activity file (FIT)" }),
    ).toBeTruthy();
  });

  it("renders heart rate and power chart labels for cycling with stream data", async () => {
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));
    expect(screen.getByText("Heart Rate")).toBeTruthy();
    expect(screen.getByText("Power")).toBeTruthy();
    const enabled = getQueryEnabledFlag(mockPowerZonesQuery.mock.calls[0]?.[1]);
    expect(enabled).toBe(true);
  });

  it("labels the heart rate zone chart with zone names", async () => {
    mockHrZonesQuery.mockReturnValue({
      data: [
        { zone: 0, label: "Below Zone 1", minPct: 0, maxPct: 50, seconds: 150, percent: 14.3 },
        { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 300, percent: 28.6 },
        { zone: 2, label: "Endurance", minPct: 60, maxPct: 70, seconds: 600, percent: 57.1 },
      ],
      isLoading: false,
    });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText("Below Zone 1")).toBeTruthy();
    expect(screen.getByText("Zone 1")).toBeTruthy();
    expect(screen.getByText("Recovery")).toBeTruthy();
    expect(screen.getByText("Zone 2")).toBeTruthy();
    expect(screen.getByText("Endurance")).toBeTruthy();
  });

  it("keeps zero-percent heart rate zone bars at zero width", async () => {
    mockHrZonesQuery.mockReturnValue({
      data: [
        { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 0, percent: 0 },
        { zone: 2, label: "Endurance", minPct: 60, maxPct: 70, seconds: 600, percent: 100 },
      ],
      isLoading: false,
      error: null,
    });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    const { container } = render(React.createElement(ActivityDetailScreen));

    const zeroPercentBar = container.querySelector('rect[fill="green"]');
    expect(zeroPercentBar?.getAttribute("width")).toBe("0");
  });

  it("shows an empty state when heart rate zones are unavailable for an activity with heart rate", async () => {
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText("No heart rate zone data")).toBeTruthy();
  });

  it("shows the heart rate zones loading state while zones are loading", async () => {
    mockHrZonesQuery.mockReturnValue({ data: [], isLoading: true, error: null });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByTestId("loading")).toBeTruthy();
    expect(screen.queryByText("No heart rate zone data")).toBeNull();
  });

  it("does not show heart rate zones for non-heart-rate streams while zones are loading", async () => {
    mockStreamQuery.mockReturnValue({
      data: streamPointsWithHrAndPower.map((point) => ({ ...point, heartRate: null })),
      isLoading: false,
    });
    mockHrZonesQuery.mockReturnValue({ data: [], isLoading: true, error: null });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.queryByText("Heart Rate Zones")).toBeNull();
    expect(screen.queryByText("No heart rate zone data")).toBeNull();
  });

  it("shows the heart rate zones error instead of the empty state when loading zones fails", async () => {
    mockHrZonesQuery.mockReturnValue({
      data: [],
      isLoading: false,
      error: { message: "Unable to load heart rate zones" },
    });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText("Unable to load heart rate zones")).toBeTruthy();
    expect(screen.queryByText("No heart rate zone data")).toBeNull();
  });

  it("labels the power zone chart with zone names", async () => {
    mockPowerZonesQuery.mockReturnValue({
      data: {
        ftp: 250,
        zones: [
          { zone: 1, label: "Recovery", minPct: 0, maxPct: 55, seconds: 300, percent: 33.3 },
          { zone: 2, label: "Endurance", minPct: 56, maxPct: 75, seconds: 600, percent: 66.7 },
        ],
      },
      isLoading: false,
    });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText("Zone 1")).toBeTruthy();
    expect(screen.getByText("Recovery")).toBeTruthy();
    expect(screen.getByText("Zone 2")).toBeTruthy();
    expect(screen.getByText("Endurance")).toBeTruthy();
  });

  it("renders without crashing for non-cycling workouts with heart rate data but no power", async () => {
    mockByIdQuery.mockReturnValue({
      data: {
        ...baseCyclingActivity,
        activityType: "yoga",
        avgPower: null,
        maxPower: null,
        name: "Yoga Session",
      },
      isLoading: false,
      error: null,
    });
    mockStreamQuery.mockReturnValue({
      data: streamPointsWithHrAndPower.map((point) => ({
        ...point,
        power: null,
        altitude: null,
      })),
      isLoading: false,
    });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));
    expect(screen.getByText("Yoga Session")).toBeTruthy();
    expect(screen.getByText("Heart Rate")).toBeTruthy();
    const enabled = getQueryEnabledFlag(mockPowerZonesQuery.mock.calls[0]?.[1]);
    expect(enabled).toBe(false);
  });

  it("shows the climbs attached to a canonical climbing activity", async () => {
    mockByIdQuery.mockReturnValue({
      data: {
        ...baseCyclingActivity,
        activityType: "climbing",
        name: "Morning Rock Climb",
      },
      isLoading: false,
      error: null,
    });
    mockClimbingEntriesQuery.mockReturnValue({
      data: [
        {
          id: "climb-v4",
          climbType: "boulder",
          gradeSystem: "v_scale",
          grade: "V4",
          sent: true,
          attemptCount: 7,
          attempts: [],
          ascentType: "Redpoint",
          holdType: null,
          routeName: "Blue Circuit",
          locationName: "Touchstone Pacific Pipe",
          sourceName: "Kaya",
          wallAngleDegrees: null,
        },
        {
          id: "climb-project",
          climbType: "boulder",
          gradeSystem: "v_scale",
          grade: "V5",
          sent: false,
          attemptCount: 1,
          attempts: [
            {
              attemptIndex: 1,
              failureReason: "technique",
              notes: null,
              outcome: "failed",
            },
          ],
          ascentType: null,
          holdType: "crimp",
          routeName: "Project",
          locationName: "Touchstone Pacific Pipe",
          sourceName: "Kaya",
          wallAngleDegrees: 35,
        },
      ],
      isLoading: false,
    });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(getQueryEnabledFlag(mockClimbingEntriesQuery.mock.calls[0]?.[1])).toBe(true);
    expect(screen.getByText("Climbs")).toBeTruthy();
    expect(screen.getByText("V4")).toBeTruthy();
    expect(screen.getByText("Blue Circuit")).toBeTruthy();
    expect(screen.getByText("Redpoint")).toBeTruthy();
    expect(screen.getByText("Sent in 7 attempts")).toBeTruthy();
    expect(screen.getByText("Project")).toBeTruthy();
    expect(screen.getByText("Attempted 1 time")).toBeTruthy();
    expect(screen.getByText("35° · Crimp")).toBeTruthy();
    expect(screen.getByText("1: Technique")).toBeTruthy();
    expect(screen.getAllByText("Touchstone Pacific Pipe")).toHaveLength(2);
  });

  it("does not query climbing entries for a raw provider type synonym", async () => {
    mockByIdQuery.mockReturnValue({
      data: {
        ...baseCyclingActivity,
        activityType: "rock_climbing",
        name: "Morning Rock Climb",
      },
      isLoading: false,
      error: null,
    });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(getQueryEnabledFlag(mockClimbingEntriesQuery.mock.calls[0]?.[1])).toBe(false);
  });

  it("shows Apple Health upstream app names when subsource is present", async () => {
    mockByIdQuery.mockReturnValue({
      data: {
        ...baseCyclingActivity,
        providerId: "apple_health",
        subsource: "Strong",
        sourceProviders: ["apple_health"],
      },
      isLoading: false,
      error: null,
    });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText(/Strong \(via Apple Health\)/)).toBeTruthy();
  });

  it("renders multiple source links for grouped Apple Health activities", async () => {
    mockByIdQuery.mockReturnValue({
      data: {
        ...baseCyclingActivity,
        providerId: "whoop",
        subsource: "WHOOP",
        sourceProviders: ["apple_health", "whoop"],
        sourceLinks: [
          {
            providerId: "apple_health",
            label: "Strong (via Apple Health)",
            url: null,
            providerAbsentAt: null,
            memberActivityId: "strong-member",
          },
          {
            providerId: "apple_health",
            label: "WHOOP (via Apple Health)",
            url: null,
            providerAbsentAt: null,
            memberActivityId: "whoop-apple-member",
          },
          {
            providerId: "whoop",
            label: "WHOOP (Cloud)",
            url: "https://app.whoop.com/activities/whoop-cloud",
            providerAbsentAt: null,
            memberActivityId: "whoop-cloud-member",
          },
        ],
      },
      isLoading: false,
      error: null,
    });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText(/Strong \(via Apple Health\)/)).toBeTruthy();
    expect(screen.getByText(/WHOOP \(via Apple Health\)/)).toBeTruthy();
    expect(screen.getByText(/WHOOP \(Cloud\)/)).toBeTruthy();
  });

  it("shows how sources were combined when the server returns a source decision", async () => {
    mockByIdQuery.mockReturnValue({
      data: {
        ...baseCyclingActivity,
        providerId: "wahoo",
        sourceProviders: ["wahoo", "strava"],
        sourceLinks: [
          {
            providerId: "strava",
            externalId: "99999",
            subsource: null,
            label: "Strava",
            url: "https://www.strava.com/activities/99999",
            providerAbsentAt: null,
          },
          {
            providerId: "wahoo",
            externalId: "42",
            subsource: null,
            label: "Wahoo",
            url: "https://example.com/wahoo/42",
            providerAbsentAt: null,
          },
        ],
        sourceDecision: {
          sourceCount: 2,
          primarySourceLabel: "Wahoo",
          explanation:
            "Wahoo was selected as the primary record by source priority. Missing details may come from the other matched sources.",
        },
      },
      isLoading: false,
      error: null,
    });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText("How sources were combined")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(
      screen.getByText(
        "Wahoo was selected as the primary record by source priority. Missing details may come from the other matched sources.",
      ),
    ).toBeTruthy();
  });

  it("hides the source decision card when sourceDecision is null", async () => {
    mockByIdQuery.mockReturnValue({
      data: baseCyclingActivity,
      isLoading: false,
      error: null,
    });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.queryByText("How sources were combined")).toBeNull();
  });

  it("shows removed provider status for provider-absent activities", async () => {
    mockByIdQuery.mockReturnValue({
      data: {
        ...baseCyclingActivity,
        providerId: "strava",
        providerAbsentAt: "2026-03-05T14:30:00.000Z",
      },
      isLoading: false,
      error: null,
    });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText("Removed from provider sync")).toBeTruthy();
    expect(screen.getByText("Removed")).toBeTruthy();
    expect(screen.getByText("Strava")).toBeTruthy();
    expect(screen.getByText(/March 5, 2026/)).toBeTruthy();
  });
});
