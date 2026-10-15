import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../server/src/repositories/climbing-test-helpers.ts";
// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { Alert, Linking } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouteMap } from "../../components/RouteMap";
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
  useRouter: () => ({ back: mockRouterBack }),
}));

vi.mock("../../components/ChartTitleWithTooltip", () => ({
  ChartTitleWithTooltip: ({ title }: { title: string }) => React.createElement("span", null, title),
}));

vi.mock("../../components/MuscleGroupBodyDiagram", () => ({
  MuscleGroupBodyDiagram: () => null,
}));

vi.mock("../../components/RouteMap", () => ({
  RouteMap: vi.fn(({ points }: { points: Array<{ lat: number | null; lng: number | null }> }) =>
    React.createElement("span", null, `Route ends at ${points.at(-1)?.lat ?? "none"}`),
  ),
}));

vi.mock("../../components/activity/useChartScrub", () => ({
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
  isActivityDetailType: (activityType: string, detailType: string) => activityType === detailType,
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
const mockRouteQuery = vi.fn();
const mockHrZonesQuery = vi.fn();
const mockPowerZonesQuery = vi.fn();
const mockStrengthExercisesQuery = vi.fn();
const mockClimbingEntriesQuery = vi.fn();
const mockHangboardDetailsQuery = vi.fn();
const mockDeleteMutate = vi.fn();
const mockRecomputeMutate = vi.fn();
const mockRecomputeShouldFail = vi.fn(() => false);
const mockRouterBack = vi.fn();
const mockActivityByIdInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityStreamInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityHrZonesInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityPowerZonesInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityStrengthExercisesInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityHangboardDetailsInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityListInvalidate = vi.fn().mockResolvedValue(undefined);
const mockCalendarWeekListInvalidate = vi.fn().mockResolvedValue(undefined);
const mockCalendarActivityOverviewInvalidate = vi.fn().mockResolvedValue(undefined);
const mockCalendarDataInvalidate = vi.fn().mockResolvedValue(undefined);
const mockEntrySuggestionsQuery = vi.fn((_input?: unknown, _options?: unknown) => ({
  data: [],
  error: null,
  isLoading: false,
}));
const mockAttachEntryMutate = vi.fn();
const mockClimbingEntriesInvalidate = vi.fn().mockResolvedValue(undefined);
const mockEntrySuggestionsInvalidate = vi.fn().mockResolvedValue(undefined);
const mockClimbingSessionSummaryInvalidate = vi.fn().mockResolvedValue(undefined);
const mockClimbingGradeProgressionInvalidate = vi.fn().mockResolvedValue(undefined);
const mockClimbingVolumeByGradeInvalidate = vi.fn().mockResolvedValue(undefined);

vi.mock("../../lib/trpc", () => ({
  trpc: {
    activity: {
      byId: { useQuery: (...args: unknown[]) => mockByIdQuery(...args) },
      stream: { useQuery: (...args: unknown[]) => mockStreamQuery(...args) },
      route: { useQuery: (...args: unknown[]) => mockRouteQuery(...args) },
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
      delete: {
        useMutation: (options?: { onSuccess?: () => Promise<void> }) => ({
          mutate: (input: { id: string }) => {
            mockDeleteMutate(input);
            void options?.onSuccess?.();
          },
          isPending: false,
        }),
      },
    },
    climbing: {
      activityLogEntries: { useQuery: (...args: unknown[]) => mockClimbingEntriesQuery(...args) },
      unattachedClimbingLogEntries: {
        useQuery: (...args: unknown[]) => mockEntrySuggestionsQuery(...args),
      },
      attachClimbingLogEntry: {
        useMutation: (options?: {
          onSuccess?: (
            result: { attached: true },
            input: { activityId: string; climbingLogEntryId: string },
          ) => Promise<void> | void;
          onError?: (
            error: Error,
            input: { activityId: string; climbingLogEntryId: string },
          ) => void;
        }) => ({
          mutate: (
            input: { activityId: string; climbingLogEntryId: string },
            callbacks?: { onSuccess?: () => void; onError?: (error: Error) => void },
          ) => {
            mockAttachEntryMutate(input);
            void options?.onSuccess?.({ attached: true }, input);
            callbacks?.onSuccess?.();
          },
          isPending: false,
        }),
      },
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
        calendarData: { invalidate: mockCalendarDataInvalidate },
      },
      climbing: {
        activityLogEntries: { invalidate: mockClimbingEntriesInvalidate },
        unattachedClimbingLogEntries: { invalidate: mockEntrySuggestionsInvalidate },
        sessionSummary: { invalidate: mockClimbingSessionSummaryInvalidate },
        gradeProgression: { invalidate: mockClimbingGradeProgressionInvalidate },
        volumeByGrade: { invalidate: mockClimbingVolumeByGradeInvalidate },
      },
    }),
  },
}));

const baseCyclingActivity = {
  id: "00000000-0000-0000-0000-000000000001",
  activityType: "cycling",
  displayedDate: "2026-04-14",
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

const attachedClimbingEntry = climbingLogEntryFixture({
  id: "attached-climb",
  providerId: "kaya",
  climbId: "attached-climb-climb",
  discipline: "rock_climbing",
  sourceName: "Kaya",
  sourceLinks: [],
  displayGrade: "V3",
  board: null,
  wallAngle: null,
  holdType: null,
  recordedClimbAttemptCount: 1,
  recordedClimbOutcome: "completed",
  climb: {
    ...climbingClimbFixture("kaya"),
    ...{
      id: "attached-climb-climb",
      name: "Attached Boulder",
      kind: "boulder",
      areaId: "attached-climb-area-0",
      areaPath: [
        {
          id: "attached-climb-area-0",
          userId: "20000000-0000-4000-8000-000000000002",
          providerId: "kaya",
          externalId: null,
          name: "Pacific Pipe",
          parentAreaId: null,
          coordinates: null,
        },
      ],
      publishedGrades: [{ value: "V3", system: "v_scale" }],
    },
  },
  attempts: [
    climbingAttemptFixture("attached-climb", {
      id: "attached-climb-attempt-0",
      outcome: "completed",
      ropeMethod: null,
      usedAid: false,
      fellOrHung: false,
      dabbed: false,
      rockResultLabels: ["sent", "Flash"],
      attemptIndex: 1,
      receivedBeta: true,
      hadCompletedBefore: false,
    }),
  ],
});

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
  vi.mocked(RouteMap).mockClear();
  mockByIdQuery.mockClear();
  mockStreamQuery.mockClear();
  mockRouteQuery.mockClear();
  mockHrZonesQuery.mockClear();
  mockPowerZonesQuery.mockClear();
  mockStrengthExercisesQuery.mockClear();
  mockClimbingEntriesQuery.mockClear();
  mockEntrySuggestionsQuery.mockReset();
  mockEntrySuggestionsQuery.mockReturnValue({ data: [], error: null, isLoading: false });
  mockAttachEntryMutate.mockClear();
  mockClimbingEntriesInvalidate.mockClear();
  mockEntrySuggestionsInvalidate.mockClear();
  mockClimbingSessionSummaryInvalidate.mockClear();
  mockClimbingGradeProgressionInvalidate.mockClear();
  mockClimbingVolumeByGradeInvalidate.mockClear();
  mockHangboardDetailsQuery.mockClear();
  mockDeleteMutate.mockClear();
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
  mockCalendarDataInvalidate.mockClear();
  mockRouterBack.mockClear();
  vi.mocked(Alert.alert).mockClear();
  vi.mocked(captureException).mockClear();
  mockByIdQuery.mockReturnValue({ data: baseCyclingActivity, isLoading: false, error: null });
  mockStreamQuery.mockReturnValue({ data: streamPointsWithHrAndPower, isLoading: false });
  mockRouteQuery.mockReturnValue({
    data: { status: "unavailable" },
    isLoading: false,
    error: null,
  });
  mockHrZonesQuery.mockReturnValue({ data: [], isLoading: false, error: null });
  mockPowerZonesQuery.mockReturnValue({ data: null, isLoading: false });
  mockStrengthExercisesQuery.mockReturnValue({ data: [], isLoading: false });
  mockClimbingEntriesQuery.mockReturnValue({ data: [], isLoading: false });
  mockHangboardDetailsQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
});

describe("ActivityDetailScreen", () => {
  it("loads hiking logs and keeps cached records visible when both refreshes fail", async () => {
    mockByIdQuery.mockReturnValue({
      data: { ...baseCyclingActivity, activityType: "hiking" },
      isLoading: false,
      error: null,
    });
    mockClimbingEntriesQuery.mockReturnValue({
      data: [climbingLogEntryFixture({ id: "cached-log", title: "Summit outing" })],
      isLoading: false,
      error: new Error("Log refresh failed"),
    });
    mockEntrySuggestionsQuery.mockReturnValue({
      data: [climbingLogEntryFixture({ id: "suggested-log", title: "Ridge traverse" })],
      isLoading: false,
      error: new Error("Suggestions refresh failed"),
    });
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));
    expect(getQueryEnabledFlag(mockClimbingEntriesQuery.mock.calls[0]?.[1])).toBe(true);
    expect(mockClimbingEntriesQuery).toHaveBeenCalledWith(
      { activityId: baseCyclingActivity.id },
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByText("Summit outing")).toBeTruthy();
    expect(screen.getByText("Ridge traverse")).toBeTruthy();
    expect(screen.getByText("Log refresh failed")).toBeTruthy();
    expect(screen.getByText("Suggestions refresh failed")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Attach entry 1, Ridge traverse to this activity" }),
    ).toBeTruthy();
  });
  it("shows route processing and disables GPX while cached sensor points are partial", async () => {
    mockStreamQuery.mockReturnValue({
      data: [{ ...streamPointsWithHrAndPower[0], lat: 37.1, lng: -122.1 }],
      isLoading: false,
    });
    mockRouteQuery.mockReturnValue({
      data: { status: "processing" },
      isLoading: false,
      error: null,
    });
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");

    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText("Processing route map…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export Activity" }));
    expect(
      screen.getByRole("button", { name: "Export as GPS track (GPX)" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("draws the ready route endpoint instead of the cached sensor endpoint", async () => {
    mockStreamQuery.mockReturnValue({
      data: [{ ...streamPointsWithHrAndPower[0], lat: 37.1, lng: -122.1 }],
      isLoading: false,
    });
    mockRouteQuery.mockReturnValue({
      data: {
        status: "ready",
        points: [
          { lat: 37.1, lng: -122.1 },
          { lat: 37.9, lng: -122.9 },
        ],
      },
      isLoading: false,
      error: null,
    });
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");

    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText("Route ends at 37.9")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export Activity" }));
    expect(
      screen.getByRole("button", { name: "Export as GPS track (GPX)" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it.each([
    "unavailable",
    "loading",
    "processing",
    "error",
    "cached error",
    "cached loading",
  ] as const)("shows canonical climbing locations when the recorded route is %s", async (state) => {
    mockByIdQuery.mockReturnValue({
      data: { ...baseCyclingActivity, activityType: "climbing" },
      isLoading: false,
      error: null,
    });
    mockRouteQuery.mockReturnValue({
      data: state.startsWith("cached")
        ? { status: "ready", points: [{ lat: 7, lng: 8 }] }
        : { status: state === "processing" ? "processing" : "unavailable" },
      error: state.endsWith("error") ? new Error("Recorded route refresh failed") : null,
      isLoading: state.endsWith("loading"),
    });
    mockClimbingEntriesQuery.mockReturnValue({
      data: [
        climbingLogEntryFixture({ id: "unlocated", title: "Unknown location" }),
        climbingLogEntryFixture({
          id: "located",
          title: "Located climb",
          mapLocation: {
            coordinates: { latitude: 0, longitude: -122.25 },
            scope: "climb",
            objectId: "source-climb",
            providerId: "mountain-project",
            name: "Located climb",
          },
        }),
      ],
      error: new Error("Climbing refresh failed"),
      isLoading: false,
    });
    mockEntrySuggestionsQuery.mockReturnValue({
      data: [
        climbingLogEntryFixture({
          id: "suggested",
          title: "Suggested climb",
          mapLocation: {
            coordinates: { latitude: 1, longitude: -122.5 },
            scope: "area",
            objectId: "source-area",
            providerId: "openbeta",
            name: "Containing area",
          },
        }),
      ],
      error: null,
      isLoading: false,
    });
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");

    render(React.createElement(ActivityDetailScreen));

    expect(screen.getAllByText("Route ends at none")).toHaveLength(
      state.startsWith("cached") ? 2 : 3,
    );
    expect(screen.getByText("Climbing refresh failed")).toBeTruthy();
    expect(screen.getByText("Climb location: Located climb · mountain-project")).toBeTruthy();
    expect(screen.getByText("Area location: Containing area · openbeta")).toBeTruthy();
    expect(screen.getByText("Entry 2")).toBeTruthy();
    const overviewProps = vi.mocked(RouteMap).mock.calls.find(([props]) => !props.compact)?.[0];
    expect(overviewProps?.climbMarkers).toEqual([
      {
        entryId: "located",
        entryNumber: 2,
        label: "Located climb",
        location: {
          coordinates: { latitude: 0, longitude: -122.25 },
          scope: "climb",
          objectId: "source-climb",
          providerId: "mountain-project",
          name: "Located climb",
        },
      },
    ]);
    act(() => overviewProps?.onSelectEntry?.("located"));
    expect(
      within(screen.getByLabelText("Climbing entry: Located climb")).getByText(
        "Entry 2 · Selected",
      ),
    ).toBeTruthy();
    const selectedOverviewProps = vi
      .mocked(RouteMap)
      .mock.calls.filter(([props]) => !props.compact)
      .at(-1)?.[0];
    expect(selectedOverviewProps?.points).toBe(overviewProps?.points);
    if (state.startsWith("cached")) {
      expect(screen.getByText("Route ends at 7")).toBeTruthy();
    }
    if (state.endsWith("error")) {
      expect(screen.getByText("Recorded route refresh failed")).toBeTruthy();
    }
  });

  it("invalidates Activities screen queries after deleting an activity", async () => {
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    fireEvent.click(screen.getByLabelText("Delete Activity"));
    const deleteAction = vi.mocked(Alert.alert).mock.calls[0]?.[2]?.[1];
    if (!deleteAction || typeof deleteAction.onPress !== "function") {
      throw new Error("Expected the destructive delete action");
    }
    deleteAction.onPress();

    await waitFor(() => {
      expect(mockDeleteMutate).toHaveBeenCalledWith({ id: baseCyclingActivity.id });
      expect(mockActivityListInvalidate).toHaveBeenCalledOnce();
      expect(mockCalendarWeekListInvalidate).toHaveBeenCalledOnce();
      expect(mockCalendarActivityOverviewInvalidate).toHaveBeenCalledOnce();
      expect(mockCalendarDataInvalidate).toHaveBeenCalledOnce();
      expect(mockRouterBack).toHaveBeenCalledOnce();
    });
  });

  it("renders the server-provided calendar date at a UTC boundary", async () => {
    mockByIdQuery.mockReturnValue({
      data: {
        ...baseCyclingActivity,
        activityType: "climbing",
        startedAt: "2026-03-18T00:30:00.000Z",
        displayedDate: "2026-03-18",
        localTimeContext: {
          timezone: null,
          startUtcOffsetMinutes: 120,
          endUtcOffsetMinutes: 120,
          source: "provider_offset",
        },
      },
      isLoading: false,
      error: null,
    });
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");

    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByText(/2026-03-18 at/)).toBeTruthy();
  });

  it("groups attached climbs and server suggestions in one card and attaches only the selected entry", async () => {
    mockByIdQuery.mockReturnValue({
      data: { ...baseCyclingActivity, activityType: "climbing", name: "Morning Rock Climb" },
      isLoading: false,
      error: null,
    });
    mockClimbingEntriesQuery.mockReturnValue({
      data: [attachedClimbingEntry],
      isLoading: false,
      error: null,
    });
    mockEntrySuggestionsQuery.mockReturnValue({
      data: [
        climbingLogEntryFixture({
          id: "tick-1",
          providerId: "mountain-project",
          climbId: "tick-1-climb",
          discipline: "rock_climbing",
          sourceName: "Mountain Project",
          sourceLinks: [],
          displayGrade: "V4",
          board: null,
          wallAngle: null,
          holdType: null,
          recordedClimbAttemptCount: 2,
          recordedClimbOutcome: "completed",
          climb: {
            ...climbingClimbFixture("mountain-project"),
            ...{
              id: "tick-1-climb",
              name: "Blue Circuit",
              kind: "boulder",
              areaId: "tick-1-area-0",
              areaPath: [
                {
                  id: "tick-1-area-0",
                  userId: "20000000-0000-4000-8000-000000000002",
                  providerId: "mountain-project",
                  externalId: null,
                  name: "Pacific Pipe",
                  parentAreaId: null,
                  coordinates: null,
                },
              ],
              publishedGrades: [{ value: "V4", system: "v_scale" }],
            },
          },
          attempts: [
            climbingAttemptFixture("tick-1", {
              id: "tick-1-attempt-0",
              outcome: "completed",
              ropeMethod: null,
              usedAid: false,
              fellOrHung: false,
              dabbed: false,
              rockResultLabels: ["sent"],
            }),
            climbingAttemptFixture("tick-1", {
              id: "tick-1-attempt-1",
              outcome: null,
              ropeMethod: null,
            }),
          ],
        }),
        climbingLogEntryFixture({
          id: "tick-2",
          providerId: "openbeta",
          climbId: "tick-2-climb",
          discipline: "rock_climbing",
          sourceName: "OpenBeta",
          sourceLinks: [],
          displayGrade: "5.10a",
          board: null,
          wallAngle: null,
          holdType: null,
          recordedClimbAttemptCount: 1,
          recordedClimbOutcome: null,
          climb: {
            ...climbingClimbFixture("openbeta"),
            ...{
              id: "tick-2-climb",
              name: "Project",
              kind: "route",
              areaId: "tick-2-area-5",
              areaPath: [
                {
                  id: "tick-2-area-0",
                  userId: "20000000-0000-4000-8000-000000000002",
                  providerId: "openbeta",
                  externalId: null,
                  name: "Country",
                  parentAreaId: null,
                  coordinates: null,
                },
                {
                  id: "tick-2-area-1",
                  userId: "20000000-0000-4000-8000-000000000002",
                  providerId: "openbeta",
                  externalId: null,
                  name: "State",
                  parentAreaId: "tick-2-area-0",
                  coordinates: null,
                },
                {
                  id: "tick-2-area-2",
                  userId: "20000000-0000-4000-8000-000000000002",
                  providerId: "openbeta",
                  externalId: null,
                  name: "Region",
                  parentAreaId: "tick-2-area-1",
                  coordinates: null,
                },
                {
                  id: "tick-2-area-3",
                  userId: "20000000-0000-4000-8000-000000000002",
                  providerId: "openbeta",
                  externalId: null,
                  name: "Park",
                  parentAreaId: "tick-2-area-2",
                  coordinates: null,
                },
                {
                  id: "tick-2-area-4",
                  userId: "20000000-0000-4000-8000-000000000002",
                  providerId: "openbeta",
                  externalId: null,
                  name: "Crag",
                  parentAreaId: "tick-2-area-3",
                  coordinates: null,
                },
                {
                  id: "tick-2-area-5",
                  userId: "20000000-0000-4000-8000-000000000002",
                  providerId: "openbeta",
                  externalId: null,
                  name: "Wall",
                  parentAreaId: "tick-2-area-4",
                  coordinates: null,
                },
              ],
              publishedGrades: [{ value: "5.10a", system: "yds" }],
            },
          },
          attempts: [
            climbingAttemptFixture("tick-2", {
              id: "tick-2-attempt-0",
              outcome: null,
              ropeMethod: "top_rope",
              fellOrHung: true,
            }),
          ],
        }),
      ],
      error: null,
      isLoading: false,
    });
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));
    expect(getQueryEnabledFlag(mockEntrySuggestionsQuery.mock.calls[0]?.[1])).toBe(true);
    const climbsCard = screen.getByText("Climbs").parentElement;
    if (!climbsCard) throw new Error("Expected a climbs card");
    expect(within(climbsCard).getByText("Attached Boulder")).toBeTruthy();
    expect(within(climbsCard).getByText("Blue Circuit")).toBeTruthy();
    expect(within(climbsCard).getByText("Project")).toBeTruthy();
    expect(within(climbsCard).getByText("Unattached")).toBeTruthy();
    expect(screen.getByText("Mountain Project")).toBeTruthy();
    expect(screen.getByText("OpenBeta")).toBeTruthy();
    expect(screen.getByText("Blue Circuit")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Details for Project" }));
    expect(screen.getByText("Country > State > Region > Park > Crag > Wall")).toBeTruthy();
    expect(screen.getByText("Top rope")).toBeTruthy();
    expect(screen.getByText("Fell or hung")).toBeTruthy();
    expect(screen.getByText("Whole climb outcome unknown · 1 recorded attempt")).toBeTruthy();
    const controls = within(climbsCard).getAllByRole("button", {
      name: /^Attach entry \d+, .* to this activity$/,
    });
    expect(controls).toHaveLength(2);
    const secondControl = controls.at(1);
    if (!secondControl) throw new Error("Expected a second attach control");
    fireEvent.click(secondControl);
    expect(mockAttachEntryMutate).toHaveBeenCalledWith({
      activityId: baseCyclingActivity.id,
      climbingLogEntryId: "tick-2",
    });
    await waitFor(() => {
      expect(mockClimbingEntriesInvalidate).toHaveBeenCalledWith({
        activityId: baseCyclingActivity.id,
      });
      expect(mockEntrySuggestionsInvalidate).toHaveBeenCalledWith({
        activityId: baseCyclingActivity.id,
      });
      expect(mockClimbingSessionSummaryInvalidate).toHaveBeenCalledWith();
      expect(mockClimbingGradeProgressionInvalidate).toHaveBeenCalledWith();
      expect(mockClimbingVolumeByGradeInvalidate).toHaveBeenCalledWith();
    });
    expect(mockActivityByIdInvalidate).not.toHaveBeenCalled();
  });

  it("shows loading, actionable error, and empty tick suggestion states", async () => {
    mockByIdQuery.mockReturnValue({
      data: { ...baseCyclingActivity, activityType: "climbing" },
      isLoading: false,
      error: null,
    });
    mockEntrySuggestionsQuery.mockReturnValue({ data: undefined, error: null, isLoading: true });
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    const view = render(React.createElement(ActivityDetailScreen));
    expect(screen.getByText("Loading climbing logs...")).toBeTruthy();
    view.unmount();
    mockEntrySuggestionsQuery.mockReturnValue({
      data: undefined,
      error: new Error("Tick service unavailable"),
      isLoading: false,
    });
    const { default: ErrorScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ErrorScreen));
    expect(screen.getByText("Tick service unavailable")).toBeTruthy();
  });

  it("shows no suggestions when the server returns no same-day ticks", async () => {
    mockByIdQuery.mockReturnValue({
      data: { ...baseCyclingActivity, activityType: "climbing" },
      isLoading: false,
      error: null,
    });
    mockEntrySuggestionsQuery.mockReturnValue({ data: [], error: null, isLoading: false });
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));
    expect(screen.getByText("No unattached climbing logs for this day.")).toBeTruthy();
  });

  it("keeps one loading panel until attached climbs resolve after empty suggestions", async () => {
    mockByIdQuery.mockReturnValue({
      data: { ...baseCyclingActivity, activityType: "climbing" },
      isLoading: false,
      error: null,
    });
    mockClimbingEntriesQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    mockEntrySuggestionsQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    const view = render(React.createElement(ActivityDetailScreen));
    const climbsCard = screen.getByText("Climbs").parentElement;
    if (!climbsCard) throw new Error("Expected a climbs card");
    expect(climbsCard.querySelectorAll('[testid="query-state-loading"]')).toHaveLength(1);
    expect(screen.queryByText("No unattached climbing logs for this day.")).toBeNull();

    mockEntrySuggestionsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    view.rerender(React.createElement(ActivityDetailScreen));
    expect(climbsCard.querySelectorAll('[testid="query-state-loading"]')).toHaveLength(1);
    expect(screen.queryByText("No unattached climbing logs for this day.")).toBeNull();

    mockClimbingEntriesQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    view.rerender(React.createElement(ActivityDetailScreen));
    expect(screen.getByText("No unattached climbing logs for this day.")).toBeTruthy();
  });

  it("keeps available suggestions attachable while attached climbs initially load", async () => {
    mockByIdQuery.mockReturnValue({
      data: { ...baseCyclingActivity, activityType: "climbing" },
      isLoading: false,
      error: null,
    });
    mockClimbingEntriesQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    mockEntrySuggestionsQuery.mockReturnValue({
      data: [
        {
          ...attachedClimbingEntry,
          id: "suggested-climb",
          climb: attachedClimbingEntry.climb && {
            ...attachedClimbingEntry.climb,
            name: "Suggested Boulder",
          },
          attempts: attachedClimbingEntry.attempts.map((a) => ({
            ...a,
            climbingLogEntryId: "suggested-climb",
          })),
        },
      ],
      isLoading: false,
      error: null,
    });
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));
    const climbsCard = screen.getByText("Climbs").parentElement;
    if (!climbsCard) throw new Error("Expected a climbs card");
    expect(within(climbsCard).getByText("Suggested Boulder")).toBeTruthy();
    expect(climbsCard.querySelectorAll('[testid="query-state-loading"]')).toHaveLength(1);
    fireEvent.click(
      within(climbsCard).getByRole("button", {
        name: "Attach entry 1, Suggested Boulder to this activity",
      }),
    );
    expect(mockAttachEntryMutate).toHaveBeenCalledWith({
      activityId: baseCyclingActivity.id,
      climbingLogEntryId: "suggested-climb",
    });
    await waitFor(() => {
      expect(mockClimbingEntriesInvalidate).toHaveBeenCalledWith({
        activityId: baseCyclingActivity.id,
      });
    });
  });

  it("keeps cached attached climbs visible while suggestions load during a refetch", async () => {
    mockByIdQuery.mockReturnValue({
      data: { ...baseCyclingActivity, activityType: "climbing" },
      isLoading: false,
      error: null,
    });
    mockClimbingEntriesQuery.mockReturnValue({
      data: [attachedClimbingEntry],
      isLoading: false,
      isFetching: true,
      error: null,
    });
    mockEntrySuggestionsQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));
    const climbsCard = screen.getByText("Climbs").parentElement;
    if (!climbsCard) throw new Error("Expected a climbs card");
    expect(within(climbsCard).getByText("Attached Boulder")).toBeTruthy();
    expect(within(climbsCard).getByText("Loading climbing logs...")).toBeTruthy();
    expect(screen.queryByText("No unattached climbing logs for this day.")).toBeNull();
  });

  it.each([null, new Error("Climbs unavailable")])(
    "does not report an empty card before attached climbs have data (error: %s)",
    async (error) => {
      mockByIdQuery.mockReturnValue({
        data: { ...baseCyclingActivity, activityType: "climbing" },
        isLoading: false,
        error: null,
      });
      mockClimbingEntriesQuery.mockReturnValue({ data: undefined, isLoading: false, error });
      mockEntrySuggestionsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
      const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
      render(React.createElement(ActivityDetailScreen));
      expect(screen.getByText("Climbs")).toBeTruthy();
      expect(screen.queryByText("No unattached climbing logs for this day.")).toBeNull();
      if (error) expect(screen.getByText("Climbs unavailable")).toBeTruthy();
    },
  );

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
        boardName: "Tension Board",
        segmentsError: null,
        summary: {
          durationSeconds: 300,
          workIntervalCount: 0,
          totalWorkDurationSeconds: null,
          totalRestDurationSeconds: null,
          exercises: [],
        },
      },
      isLoading: false,
      error: null,
    });
    const rerendered = render(React.createElement(ActivityDetailScreen));
    rerendered.rerender(React.createElement(ActivityDetailScreen));
    expect(getQueryEnabledFlag(mockHangboardDetailsQuery.mock.calls.at(-1)?.[1])).toBe(true);
    expect(screen.getAllByText("Hangboarding")).toHaveLength(1);
    expect(screen.getAllByText("Imported 7/3")).toHaveLength(1);
  });

  it("renders the activity's stored session perceived exertion", async () => {
    mockByIdQuery.mockReturnValue({
      data: { ...baseCyclingActivity, perceivedExertion: 7 },
      isLoading: false,
      error: null,
    });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(screen.getByLabelText("Session perceived exertion")).toBeTruthy();
    expect(screen.getByText("7/10")).toBeTruthy();
  });

  it("hides an unrecorded detail metric without GPS", async () => {
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

    expect(screen.queryByText("Distance unavailable")).toBeNull();
    expect(screen.queryByText("Distance not recorded")).toBeNull();
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

  it.each(["Onsight", "Flash", "Redpoint"] as const)(
    "uses %s badges for successful attached and unattached climbs",
    async (ascentType) => {
      mockByIdQuery.mockReturnValue({
        data: { ...baseCyclingActivity, activityType: "climbing" },
        isLoading: false,
        error: null,
      });
      const climb = climbingLogEntryFixture({
        id: "first-try-climb",
        providerId: "mountain-project",
        climbId: "first-try-climb-climb",
        discipline: "rock_climbing",
        sourceName: "Mountain Project",
        sourceLinks: [],
        displayGrade: "5.6",
        board: null,
        wallAngle: null,
        holdType: null,
        recordedClimbAttemptCount: ascentType === "Redpoint" ? 7 : 1,
        recordedClimbOutcome: "completed",
        climb: {
          ...climbingClimbFixture("mountain-project"),
          ...{
            id: "first-try-climb-climb",
            name: "Attached Arete",
            kind: "route",
            areaId: "first-try-climb-area-0",
            areaPath: [
              {
                id: "first-try-climb-area-0",
                userId: "20000000-0000-4000-8000-000000000002",
                providerId: "mountain-project",
                externalId: null,
                name: "Kombucha Crag",
                parentAreaId: null,
                coordinates: null,
              },
            ],
            publishedGrades: [{ value: "5.6", system: "yds" }],
          },
        },
        attempts: Array.from({ length: ascentType === "Redpoint" ? 7 : 1 }, (_, index) =>
          climbingAttemptFixture("first-try-climb", {
            id: `first-try-climb-attempt-${index}`,
            outcome: index === 0 ? "completed" : null,
            ropeMethod: "lead",
            usedAid: index === 0 ? false : null,
            fellOrHung: index === 0 ? false : null,
            rockResultLabels:
              index === 0 ? (ascentType === "Redpoint" ? ["sent"] : ["sent", ascentType]) : [],
            attemptIndex: index === 0 && ascentType !== "Redpoint" ? 1 : null,
            receivedBeta: index === 0 && ascentType !== "Redpoint" ? ascentType === "Flash" : null,
            hadCompletedBefore: index === 0 && ascentType !== "Redpoint" ? false : null,
          }),
        ),
      });
      mockClimbingEntriesQuery.mockReturnValue({ data: [climb], isLoading: false, error: null });
      mockEntrySuggestionsQuery.mockReturnValue({
        data: [
          {
            ...climb,
            id: "unattached-climb",
            climb: climb.climb && { ...climb.climb, name: "Left Arete" },
            attempts: climb.attempts.map((a) => ({ ...a, climbingLogEntryId: "unattached-climb" })),
          },
        ],
        isLoading: false,
        error: null,
      });
      const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
      render(React.createElement(ActivityDetailScreen));
      expect(screen.getByText("Attached Arete")).toBeTruthy();
      expect(screen.getByText("Left Arete")).toBeTruthy();
      expect(screen.getAllByText(ascentType === "Redpoint" ? "Sent" : ascentType)).toHaveLength(2);
      if (ascentType === "Redpoint") {
        expect(screen.getAllByText("Whole climb completed · 7 recorded attempts")).toHaveLength(2);
      } else {
        expect(screen.getAllByText("5.6", { exact: true })).toHaveLength(2);
        expect(screen.getAllByText("Whole climb completed · 1 recorded attempt")).toHaveLength(2);
      }
    },
  );

  it("shows attached and suggested Mountain Project top-rope ticks without unavailable outcomes", async () => {
    mockByIdQuery.mockReturnValue({
      data: { ...baseCyclingActivity, activityType: "climbing" },
      isLoading: false,
      error: null,
    });
    const climb = climbingLogEntryFixture({
      id: "swiss-cheese",
      providerId: "mountain-project",
      climbId: "swiss-cheese-climb",
      discipline: "rock_climbing",
      sourceName: "Mountain Project",
      sourceLinks: [
        {
          providerId: "mountain-project",
          kind: "route",
          url: "https://www.mountainproject.com/route/105734732/swiss-cheese",
        },
        {
          providerId: "mountain-project",
          kind: "ticks",
          url: "https://www.mountainproject.com/user/110186720/ticks/ticks",
        },
      ],
      displayGrade: "5.4",
      board: null,
      wallAngle: null,
      holdType: null,
      recordedClimbAttemptCount: 1,
      recordedClimbOutcome: null,
      climb: {
        ...climbingClimbFixture("mountain-project"),
        ...{
          id: "swiss-cheese-climb",
          name: "Swiss Cheese",
          kind: "route",
          areaId: "swiss-cheese-area-1",
          areaPath: [
            {
              id: "swiss-cheese-area-0",
              userId: "20000000-0000-4000-8000-000000000002",
              providerId: "mountain-project",
              externalId: null,
              name: "California",
              parentAreaId: null,
              coordinates: null,
            },
            {
              id: "swiss-cheese-area-1",
              userId: "20000000-0000-4000-8000-000000000002",
              providerId: "mountain-project",
              externalId: null,
              name: "Goat Rock",
              parentAreaId: "swiss-cheese-area-0",
              coordinates: null,
            },
          ],
          publishedGrades: [{ value: "5.4", system: "yds" }],
        },
      },
      attempts: [
        climbingAttemptFixture("swiss-cheese", {
          id: "swiss-cheese-attempt-0",
          outcome: null,
          ropeMethod: "top_rope",
        }),
      ],
    });
    mockClimbingEntriesQuery.mockReturnValue({ data: [climb], isLoading: false, error: null });
    mockEntrySuggestionsQuery.mockReturnValue({
      data: [
        {
          ...climb,
          id: "unattached-swiss-cheese",
          attempts: climb.attempts.map((a) => ({
            ...a,
            climbingLogEntryId: "unattached-swiss-cheese",
          })),
        },
      ],
      isLoading: false,
      error: null,
    });
    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));
    expect(screen.getAllByText("Swiss Cheese")).toHaveLength(2);
    for (const link of screen.getAllByRole("link", { name: "Swiss Cheese on mountain-project" }))
      fireEvent.click(link);
    for (const link of screen.getAllByRole("link", { name: "mountain-project ticks" }))
      fireEvent.click(link);
    expect(Linking.openURL).toHaveBeenCalledWith(
      "https://www.mountainproject.com/route/105734732/swiss-cheese",
    );
    expect(Linking.openURL).toHaveBeenCalledWith(
      "https://www.mountainproject.com/user/110186720/ticks/ticks",
    );
    expect(screen.getAllByText("5.4", { exact: true })).toHaveLength(2);
    expect(screen.getAllByText("Goat Rock")).toHaveLength(2);
    for (const control of screen.getAllByRole("button", { name: "Details for Swiss Cheese" }))
      fireEvent.click(control);
    expect(screen.getAllByText("California > Goat Rock")).toHaveLength(2);
    expect(screen.getAllByText("Top rope")).toHaveLength(2);
    expect(screen.getAllByText("Mountain Project")).toHaveLength(2);
    expect(screen.queryByText("Result unknown")).toBeNull();
    expect(screen.getAllByText("Whole climb outcome unknown · 1 recorded attempt")).toHaveLength(2);
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
        climbingLogEntryFixture({
          id: "climb-v4",
          providerId: "kaya",
          climbId: "climb-v4-climb",
          discipline: "rock_climbing",
          sourceName: "Kaya",
          sourceLinks: [],
          displayGrade: "V4",
          board: { name: "Training Board", externalId: "board-1" },
          wallAngle: { value: -20, unit: null },
          holdType: null,
          recordedClimbAttemptCount: 7,
          recordedClimbOutcome: "completed",
          climb: {
            ...climbingClimbFixture("kaya"),
            ...{
              id: "climb-v4-climb",
              name: "Blue Circuit",
              kind: "boulder",
              areaId: "climb-v4-area-0",
              areaPath: [
                {
                  id: "climb-v4-area-0",
                  userId: "20000000-0000-4000-8000-000000000002",
                  providerId: "kaya",
                  externalId: null,
                  name: "Touchstone Pacific Pipe",
                  parentAreaId: null,
                  coordinates: null,
                },
              ],
              publishedGrades: [{ value: "V4", system: "v_scale" }],
            },
          },
          attempts: [
            climbingAttemptFixture("climb-v4", {
              id: "climb-v4-attempt-0",
              outcome: "completed",
              ropeMethod: null,
              usedAid: false,
              fellOrHung: false,
              dabbed: false,
              rockResultLabels: ["sent"],
            }),
            climbingAttemptFixture("climb-v4", {
              id: "climb-v4-attempt-1",
              outcome: null,
              ropeMethod: null,
            }),
            climbingAttemptFixture("climb-v4", {
              id: "climb-v4-attempt-2",
              outcome: null,
              ropeMethod: null,
            }),
            climbingAttemptFixture("climb-v4", {
              id: "climb-v4-attempt-3",
              outcome: null,
              ropeMethod: null,
            }),
            climbingAttemptFixture("climb-v4", {
              id: "climb-v4-attempt-4",
              outcome: null,
              ropeMethod: null,
            }),
            climbingAttemptFixture("climb-v4", {
              id: "climb-v4-attempt-5",
              outcome: null,
              ropeMethod: null,
            }),
            climbingAttemptFixture("climb-v4", {
              id: "climb-v4-attempt-6",
              outcome: null,
              ropeMethod: null,
            }),
          ],
        }),
        climbingLogEntryFixture({
          id: "climb-project",
          providerId: "kaya",
          climbId: "climb-project-climb",
          discipline: "rock_climbing",
          sourceName: "Kaya",
          sourceLinks: [],
          displayGrade: "V5",
          board: null,
          wallAngle: { value: 35, unit: "degrees" },
          holdType: "crimp",
          recordedClimbAttemptCount: 1,
          recordedClimbOutcome: "failed",
          climb: {
            ...climbingClimbFixture("kaya"),
            ...{
              id: "climb-project-climb",
              name: "Project",
              kind: "boulder",
              areaId: "climb-project-area-0",
              areaPath: [
                {
                  id: "climb-project-area-0",
                  userId: "20000000-0000-4000-8000-000000000002",
                  providerId: "kaya",
                  externalId: null,
                  name: "Touchstone Pacific Pipe",
                  parentAreaId: null,
                  coordinates: null,
                },
              ],
              publishedGrades: [{ value: "V5", system: "v_scale" }],
            },
          },
          attempts: [
            climbingAttemptFixture("climb-project", {
              id: "climb-project-attempt-0",
              outcome: "failed",
              ropeMethod: null,
              attemptIndex: 1,
            }),
          ],
        }),
        climbingLogEntryFixture({
          id: "kaya-unsent",
          providerId: "kaya",
          climbId: "kaya-unsent-climb",
          discipline: "rock_climbing",
          sourceName: "Kaya",
          sourceLinks: [],
          displayGrade: "V3",
          board: null,
          wallAngle: null,
          holdType: null,
          recordedClimbAttemptCount: 1,
          recordedClimbOutcome: null,
          climb: {
            ...climbingClimbFixture("kaya"),
            ...{
              id: "kaya-unsent-climb",
              name: null,
              kind: "boulder",
              areaId: "kaya-unsent-area-0",
              areaPath: [
                {
                  id: "kaya-unsent-area-0",
                  userId: "20000000-0000-4000-8000-000000000002",
                  providerId: "kaya",
                  externalId: null,
                  name: "Touchstone Pacific Pipe",
                  parentAreaId: null,
                  coordinates: null,
                },
              ],
              publishedGrades: [{ value: "V3", system: "v_scale" }],
            },
          },
          attempts: [
            climbingAttemptFixture("kaya-unsent", {
              id: "kaya-unsent-attempt-0",
              outcome: null,
              ropeMethod: null,
            }),
          ],
        }),
      ],
      isLoading: false,
    });

    const { default: ActivityDetailScreen } = await import("../../app/activity/[id]");
    render(React.createElement(ActivityDetailScreen));

    expect(getQueryEnabledFlag(mockClimbingEntriesQuery.mock.calls[0]?.[1])).toBe(true);
    expect(screen.getByText("Climbs")).toBeTruthy();
    expect(screen.queryByText("No unattached climbing logs for this day.")).toBeNull();
    expect(screen.getByText("V4")).toBeTruthy();
    expect(screen.getByText("Blue Circuit")).toBeTruthy();
    expect(screen.getByText("Sent")).toBeTruthy();
    expect(screen.getByText("Board: Training Board")).toBeTruthy();
    expect(screen.getByText("Wall angle: −20 (units unknown)")).toBeTruthy();
    expect(screen.getByText("Whole climb completed · 7 recorded attempts")).toBeTruthy();
    expect(screen.getByText("Project")).toBeTruthy();
    expect(screen.getByText("Whole climb failed · 1 recorded attempt")).toBeTruthy();
    expect(screen.getByText("Wall angle: 35°")).toBeTruthy();
    expect(screen.getByText("Whole climb outcome unknown · 1 recorded attempt")).toBeTruthy();
    expect(screen.getAllByText("Touchstone Pacific Pipe")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Details for Project" }));
    expect(screen.getByText("Hold type: crimp")).toBeTruthy();
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

    expect(screen.getByRole("button", { name: "How sources were combined" })).toBeTruthy();
    expect(screen.queryByText("2")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "How sources were combined" }));
    expect(screen.getByText("2")).toBeTruthy();
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
