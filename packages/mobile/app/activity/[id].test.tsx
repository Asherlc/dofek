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
  formatDurationRange: () => "1:00:00",
  formatNumber: (value: number) => String(value),
}));

vi.mock("@dofek/format/units", () => ({}));

vi.mock("@dofek/providers/providers", () => ({
  providerLabel: (id: string) => id,
}));

vi.mock("@dofek/scoring/colors", () => ({
  activityMetricColors: { heartRate: "red", power: "orange" },
  statusColors: {},
}));

vi.mock("@dofek/training/muscle-groups", () => ({}));

vi.mock("@dofek/training/training", () => ({
  formatActivityTypeLabel: (type: string) => type,
  isCyclingActivity: (type: string) => type === "cycling",
}));

vi.mock("@dofek/zones/zones", () => ({
  HEART_RATE_ZONE_COLORS: ["green", "lime", "yellow", "orange", "red"],
  POWER_ZONE_COLORS: ["#0ea5e9", "#2563eb", "#16a34a", "#ca8a04", "#ea580c", "#dc2626", "#5E35B1"],
}));

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
  mockHrZonesQuery.mockReturnValue({ data: [], isLoading: false });
  mockPowerZonesQuery.mockReturnValue({ data: null, isLoading: false });
  mockStrengthExercisesQuery.mockReturnValue({ data: [], isLoading: false });
});

describe("ActivityDetailScreen", () => {
  it("renders without crashing when stream has heart rate and power data", async () => {
    const { default: ActivityDetailScreen } = await import("./[id]");
    render(React.createElement(ActivityDetailScreen));
    expect(screen.getByText("Morning Ride")).toBeTruthy();
  });

  it("renders heart rate and power chart labels for cycling with stream data", async () => {
    const { default: ActivityDetailScreen } = await import("./[id]");
    render(React.createElement(ActivityDetailScreen));
    expect(screen.getByText("Heart Rate")).toBeTruthy();
    expect(screen.getByText("Power")).toBeTruthy();
    const enabled = getQueryEnabledFlag(mockPowerZonesQuery.mock.calls[0]?.[1]);
    expect(enabled).toBe(true);
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
});
