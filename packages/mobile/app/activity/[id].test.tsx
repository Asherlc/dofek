// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

function stripStyle({
  style: _s,
  contentContainerStyle: _cs,
  scrollEnabled: _se,
  ...rest
}: Record<string, unknown>) {
  return rest;
}

vi.mock("react-native", () => ({
  View: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", stripStyle(props), ...(children != null ? [children] : [])),
  Text: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("span", stripStyle(props), ...(children != null ? [children] : [])),
  ScrollView: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement("div", stripStyle(props), ...(children != null ? [children] : [])),
  Pressable: ({ children, onPress, ...props }: Record<string, unknown>) =>
    React.createElement(
      "button",
      { ...stripStyle(props), type: "button", onClick: onPress },
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

vi.mock("./useChartScrub", () => ({
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
    accent: "#00f",
    positive: "#0f0",
    danger: "#f00",
  },
}));

vi.mock("@dofek/format/format", () => ({
  formatDateLong: (value: string) => (value.startsWith("2026-03-05") ? "March 5, 2026" : value),
  formatDurationRange: () => "1:00:00",
  formatDurationSeconds: (value: number) => `${value}s`,
  formatNumber: (value: number) => String(value),
  formatTimeOnly: (value: string) => value,
}));

vi.mock("@dofek/format/units", () => ({}));

vi.mock("@dofek/providers/providers", () => ({
  providerLabel: (id: string) => (id === "strava" ? "Strava" : id),
  providerSourceLabel: (id: string, subsource?: string | null) =>
    id === "apple_health" && subsource
      ? `${subsource} (via Apple Health)`
      : id === "strava"
        ? "Strava"
        : id,
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

vi.mock("../../lib/trpc", () => ({
  trpc: {
    activity: {
      byId: { useQuery: (...args: unknown[]) => mockByIdQuery(...args) },
      stream: { useQuery: (...args: unknown[]) => mockStreamQuery(...args) },
      hrZones: { useQuery: (...args: unknown[]) => mockHrZonesQuery(...args) },
      powerZones: { useQuery: (...args: unknown[]) => mockPowerZonesQuery(...args) },
      strengthExercises: { useQuery: (...args: unknown[]) => mockStrengthExercisesQuery(...args) },
      delete: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    useUtils: () => ({ activity: { list: { invalidate: vi.fn() } } }),
  },
}));

const baseCyclingActivity = {
  id: "00000000-0000-0000-0000-000000000001",
  activityType: "cycling",
  startedAt: "2026-04-14T10:00:00.000Z",
  endedAt: "2026-04-14T11:00:00.000Z",
  name: "Morning Ride",
  notes: null,
  providerId: "wahoo",
  subsource: null,
  sourceProviders: ["wahoo"],
  sourceLinks: [],
  avgHr: 145,
  maxHr: 172,
  avgPower: 220,
  maxPower: 350,
  avgSpeed: 30,
  maxSpeed: 50,
  avgCadence: 88,
  totalDistance: 30000,
  elevationGain: 400,
  elevationLoss: 380,
  sampleCount: 200,
  perceivedExertion: null,
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

beforeEach(() => {
  mockByIdQuery.mockClear();
  mockStreamQuery.mockClear();
  mockHrZonesQuery.mockClear();
  mockPowerZonesQuery.mockClear();
  mockStrengthExercisesQuery.mockClear();
  mockByIdQuery.mockReturnValue({ data: baseCyclingActivity, isLoading: false, error: null });
  mockStreamQuery.mockReturnValue({ data: streamPointsWithHrAndPower, isLoading: false });
  mockHrZonesQuery.mockReturnValue({ data: [], isLoading: false, error: null });
  mockPowerZonesQuery.mockReturnValue({ data: null, isLoading: false });
  mockStrengthExercisesQuery.mockReturnValue({ data: [], isLoading: false });
});

describe("ActivityDetailScreen", () => {
  it("renders without crashing when stream has heart rate and power data", async () => {
    const { default: ActivityDetailScreen } = await import("./[id]");
    render(React.createElement(ActivityDetailScreen));
    expect(screen.getByText("Morning Ride")).toBeTruthy();
  });

  it("shows session effort only when it was recorded", async () => {
    mockByIdQuery.mockReturnValue({
      data: { ...baseCyclingActivity, perceivedExertion: 7 },
      isLoading: false,
      error: null,
    });

    const { default: ActivityDetailScreen } = await import("./[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText("Session effort")).toBeTruthy();
    expect(screen.getByText("7 / 10")).toBeTruthy();
  });

  it("does not show a session effort card when it was not recorded", async () => {
    const { default: ActivityDetailScreen } = await import("./[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.queryByText("Session effort")).toBeNull();
  });

  it("renders heart rate and power chart labels for cycling with stream data", async () => {
    const { default: ActivityDetailScreen } = await import("./[id]");
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

    const { default: ActivityDetailScreen } = await import("./[id]");
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

    const { default: ActivityDetailScreen } = await import("./[id]");
    const { container } = render(React.createElement(ActivityDetailScreen));

    const zeroPercentBar = container.querySelector('rect[fill="green"]');
    expect(zeroPercentBar?.getAttribute("width")).toBe("0");
  });

  it("shows an empty state when heart rate zones are unavailable for an activity with heart rate", async () => {
    const { default: ActivityDetailScreen } = await import("./[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText("No heart rate zone data")).toBeTruthy();
  });

  it("shows the heart rate zones loading state while zones are loading", async () => {
    mockHrZonesQuery.mockReturnValue({ data: [], isLoading: true, error: null });

    const { default: ActivityDetailScreen } = await import("./[id]");
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

    const { default: ActivityDetailScreen } = await import("./[id]");
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

    const { default: ActivityDetailScreen } = await import("./[id]");
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

    const { default: ActivityDetailScreen } = await import("./[id]");
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

    const { default: ActivityDetailScreen } = await import("./[id]");
    render(React.createElement(ActivityDetailScreen));
    expect(screen.getByText("Yoga Session")).toBeTruthy();
    expect(screen.getByText("Heart Rate")).toBeTruthy();
    const enabled = getQueryEnabledFlag(mockPowerZonesQuery.mock.calls[0]?.[1]);
    expect(enabled).toBe(false);
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

    const { default: ActivityDetailScreen } = await import("./[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText(/Strong \(via Apple Health\)/)).toBeTruthy();
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

    const { default: ActivityDetailScreen } = await import("./[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText("Removed from provider sync")).toBeTruthy();
    expect(screen.getByText("Removed")).toBeTruthy();
    expect(screen.getByText("Strava")).toBeTruthy();
    expect(screen.getByText(/March 5, 2026/)).toBeTruthy();
  });
});
