import React from "react";
import { vi } from "vitest";

type MockPropsWithChildren = React.PropsWithChildren<Record<string, unknown>>;
export const activityAlert = vi.fn();

export const activityDetailSimpleMocks = {
  ChartTitleWithTooltip: ({ title }: { title: string }) => React.createElement("span", null, title),
  MuscleGroupBodyDiagram: () => null,
  ProviderLogo: () => null,
  unitConverter: () => ({
    useUnitConverter: () => ({
      convertDistance: (km: number) => km,
      distanceLabel: "km",
      convertSpeed: (speed: number) => speed,
      speedLabel: "km/h",
      convertElevation: (elevation: number) => elevation,
      elevationLabel: "m",
      convertWeight: (kg: number) => kg,
      weightLabel: "kg",
      convertTemperature: (celsius: number) => (celsius * 9) / 5 + 32,
      temperatureLabel: "°F",
    }),
  }),
  activityExport: { downloadActivityExport: vi.fn() },
  telemetry: { captureException: vi.fn() },
  trainingMuscleGroups: {},
  formatUnits: {},
};

export async function createActivityDetailThemeMock(
  importOriginal: () => Promise<typeof import("../../theme")>,
) {
  return {
    ...(await importOriginal()),
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
  };
}

export async function createActivityDetailFormatMock(
  importOriginal: () => Promise<typeof import("@dofek/format/format")>,
) {
  const actual = await importOriginal();
  return {
    ...actual,
    formatDateLong: (value: string) => (value.startsWith("2026-03-05") ? "March 5, 2026" : value),
    formatDateTime: (value: string | number | Date) => {
      const timestamp = typeof value === "string" ? value : new Date(value).toISOString();
      return timestamp.startsWith("2026-03-05") ? "March 5, 2026, 2:30 PM" : timestamp;
    },
    formatDurationRange: () => "1:00:00",
    formatDurationSeconds: (value: number) => `${value}s`,
    formatNumber: (value: number, decimals?: number) =>
      decimals === undefined ? String(value) : actual.formatNumber(value, decimals),
    formatTimeOnly: (value: string | number | Date) =>
      typeof value === "string" ? value : new Date(value).toISOString(),
  };
}

export async function createActivityDetailProviderMock(
  importOriginal: () => Promise<typeof import("@dofek/providers/providers")>,
) {
  return {
    ...(await importOriginal()),
    providerLabel: (id: string) =>
      id === "strava" ? "Strava" : id === "kilter" ? "Kilter Board" : id,
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
  };
}

export async function createActivityDetailScoringMock(
  importOriginal: () => Promise<typeof import("@dofek/scoring/colors")>,
) {
  return {
    ...(await importOriginal()),
    activityMetricColors: { heartRate: "red", power: "orange", skinTemperature: "tomato" },
    chartColors: { teal: "#0ea5e9", purple: "#5E35B1" },
    statusColors: {
      positive: "#16a34a",
      warning: "#ca8a04",
      danger: "#dc2626",
      info: "#2563eb",
      elevated: "#ea580c",
    },
    textColors: { neutral: "#8aaa8a" },
  };
}

export async function createActivityDetailTrainingMock(
  importOriginal: () => Promise<typeof import("@dofek/training/training")>,
) {
  return {
    ...(await importOriginal()),
    formatActivityTypeLabel: (type: string) => type,
    isActivityDetailType: (activityType: string, detailType: string) => activityType === detailType,
    isCyclingActivity: (type: string) => type === "cycling",
    cadenceUnit: (type: string) => (type === "cycling" ? "rpm" : "steps/min"),
  };
}

export async function createActivityDetailZonesMock(
  importOriginal: () => Promise<typeof import("@dofek/zones/zones")>,
) {
  return {
    ...(await importOriginal()),
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
}

const hardwareRefetch = vi.fn();
export const routeMocks = {
  byIdQuery: vi.fn(),
  imagesQuery: vi.fn(),
  streamQuery: vi.fn(),
  heartRateContextQuery: vi.fn(),
  routeQuery: vi.fn(),
  hrZonesQuery: vi.fn(),
  powerZonesQuery: vi.fn(),
  powerWorkQuery: vi.fn(),
  strengthExercisesQuery: vi.fn(),
  climbingEntriesQuery: vi.fn(),
  hangboardDetailsQuery: vi.fn(),
  deleteMutate: vi.fn(),
  restoreProviderAbsentMutate: vi.fn(),
  restoreResult: vi.fn<() => { analyticsJobId: string } | undefined>(() => undefined),
  restoreStatus: vi.fn<
    () => { data: { status: "pending" | "completed"; error: null } | undefined; error: null }
  >(() => ({ data: undefined, error: null })),
  routerBack: vi.fn(),
  routerPush: vi.fn(),
  activityByIdInvalidate: vi.fn().mockResolvedValue(undefined),
  activityInvalidate: vi.fn().mockResolvedValue(undefined),
  activityStreamInvalidate: vi.fn().mockResolvedValue(undefined),
  activityHrZonesInvalidate: vi.fn().mockResolvedValue(undefined),
  activityPowerZonesInvalidate: vi.fn().mockResolvedValue(undefined),
  activityPowerWorkInvalidate: vi.fn().mockResolvedValue(undefined),
  activityStrengthExercisesInvalidate: vi.fn().mockResolvedValue(undefined),
  activityHangboardDetailsInvalidate: vi.fn().mockResolvedValue(undefined),
  activityListInvalidate: vi.fn().mockResolvedValue(undefined),
  calendarWeekListInvalidate: vi.fn().mockResolvedValue(undefined),
  calendarActivityOverviewInvalidate: vi.fn().mockResolvedValue(undefined),
  calendarDataInvalidate: vi.fn().mockResolvedValue(undefined),
  entrySuggestionsQuery: vi.fn((_input?: unknown, _options?: unknown) => ({
    data: [],
    error: null,
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
  })),
  metricSourcesQuery: vi.fn((_input?: unknown, _options?: unknown) => ({
    data: [],
    error: null,
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
  })),
  hardwareRefetch,
  hardwareQuery: vi.fn((_input?: unknown, _options?: unknown) => ({
    data: { items: [], power: [] },
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    error: null,
    refetch: hardwareRefetch,
  })),
  attachEntryMutate: vi.fn(),
  activityImagesInvalidate: vi.fn().mockResolvedValue(undefined),
  climbingEntriesInvalidate: vi.fn().mockResolvedValue(undefined),
  entrySuggestionsInvalidate: vi.fn().mockResolvedValue(undefined),
  climbingSessionSummaryInvalidate: vi.fn().mockResolvedValue(undefined),
  mobileTrainingInvalidate: vi.fn().mockResolvedValue(undefined),
  climbingStrengthsInvalidate: vi.fn().mockResolvedValue(undefined),
  climbingVolumeByGradeInvalidate: vi.fn().mockResolvedValue(undefined),
};

export const activityRouteParams = {
  id: "00000000-0000-0000-0000-000000000001",
};

export const routeMapMock = vi.fn(
  ({
    points,
    hoveredPosition,
  }: {
    points: Array<{ lat: number | null; lng: number | null }>;
    hoveredPosition?: { lat: number; lng: number } | null;
  }) =>
    React.createElement(
      "span",
      { "data-hover-lat": hoveredPosition?.lat ?? "" },
      `Route ends at ${points.at(-1)?.lat ?? "none"}`,
    ),
);

export const chartScrub: {
  startedAt: number | null;
  endedAt: number | null;
  onHoverTime: ((timestamp: number | null) => void) | null;
  onScrubStart: (() => void) | null;
  onScrubEnd: (() => void) | null;
} = {
  startedAt: null,
  endedAt: null,
  onHoverTime: null,
  onScrubStart: null,
  onScrubEnd: null,
};

export function createChartScrubMock() {
  return {
    useChartScrub: (options: {
      series: { startedAt: number; endedAt: number };
      onHoverTime?: (timestamp: number | null) => void;
      onScrubStart?: () => void;
      onScrubEnd?: () => void;
    }) => {
      chartScrub.startedAt = options.series.startedAt;
      chartScrub.endedAt = options.series.endedAt;
      chartScrub.onHoverTime = options.onHoverTime ?? null;
      chartScrub.onScrubStart = options.onScrubStart ?? null;
      chartScrub.onScrubEnd = options.onScrubEnd ?? null;
      return { touchIndex: null, panResponder: { panHandlers: {} } };
    },
  };
}

export function getQueryEnabledFlag(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const enabled = Reflect.get(value, "enabled");
  return typeof enabled === "boolean" ? enabled : undefined;
}

export function getPlaceholderData(
  value: unknown,
):
  | ((previousData: unknown, previousQuery?: { queryKey: readonly unknown[] }) => unknown)
  | undefined {
  if (!value || typeof value !== "object") return undefined;
  const placeholderData = Reflect.get(value, "placeholderData");
  return typeof placeholderData === "function" ? placeholderData : undefined;
}

export function stripStyle({
  style: _style,
  contentContainerStyle: _contentContainerStyle,
  scrollEnabled: _scrollEnabled,
  ...rest
}: Record<string, unknown>) {
  return rest;
}

export function createReactNativeMock() {
  return {
    View: ({
      children,
      accessibilityLabel,
      accessibilityRole,
      accessible,
      style,
      ...props
    }: MockPropsWithChildren) =>
      React.createElement(
        "div",
        {
          ...stripStyle({ ...props, style }),
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          "data-accessible": accessible,
          "data-style": JSON.stringify(style),
        },
        ...(children != null ? [children] : []),
      ),
    Text: ({
      children,
      accessible,
      accessibilityState,
      ...props
    }: React.PropsWithChildren<
      Record<string, unknown> & { accessibilityState?: { selected?: boolean } }
    >) =>
      React.createElement(
        "span",
        {
          ...stripStyle(props),
          "data-accessible": accessible,
          "aria-selected": accessibilityState?.selected,
        },
        ...(children != null ? [children] : []),
      ),
    ScrollView: ({
      children,
      scrollEnabled,
      ...props
    }: React.PropsWithChildren<Record<string, unknown> & { scrollEnabled?: boolean }>) =>
      React.createElement(
        "div",
        { ...stripStyle(props), "data-scroll-enabled": scrollEnabled },
        ...(children != null ? [children] : []),
      ),
    Pressable: ({
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      accessible,
      children,
      onPress,
      ...props
    }: React.PropsWithChildren<
      Record<string, unknown> & { accessibilityState?: { selected?: boolean } }
    >) =>
      React.createElement(
        "button",
        {
          ...stripStyle(props),
          type: "button",
          onClick: onPress,
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          "data-accessible": accessible,
          "aria-selected": accessibilityState?.selected,
        },
        ...(children != null ? [children] : []),
      ),
    ActivityIndicator: () => React.createElement("div", { "data-testid": "loading" }),
    Image: ({ accessibilityLabel, ...props }: Record<string, unknown>) =>
      React.createElement("img", { ...stripStyle(props), "aria-label": accessibilityLabel }),
    Alert: { alert: activityAlert },
    Modal: ({ children, visible }: MockPropsWithChildren) =>
      visible ? React.createElement("div", { "data-testid": "modal" }, children) : null,
    TouchableOpacity: ({ children, onPress, accessibilityLabel }: MockPropsWithChildren) =>
      React.createElement(
        "button",
        { type: "button", onClick: onPress, "aria-label": accessibilityLabel },
        children,
      ),
    Linking: { openURL: vi.fn() },
    StyleSheet: {
      create: <T extends Record<string, unknown>>(styles: T): T => styles,
      hairlineWidth: 1,
    },
  };
}

export function createSvgMock() {
  return {
    __esModule: true,
    SvgXml: ({ xml, color, width, height }: Record<string, unknown>) =>
      React.createElement("SvgXml", { xml, color, width, height }),
    default: ({ children, ...props }: MockPropsWithChildren) =>
      React.createElement("svg", props, ...(children != null ? [children] : [])),
    Circle: (props: Record<string, unknown>) => React.createElement("circle", props),
    Defs: ({ children, ...props }: MockPropsWithChildren) =>
      React.createElement("defs", props, ...(children != null ? [children] : [])),
    G: ({ children, ...props }: MockPropsWithChildren) =>
      React.createElement("g", props, ...(children != null ? [children] : [])),
    Line: (props: Record<string, unknown>) => React.createElement("line", props),
    LinearGradient: ({ children, ...props }: MockPropsWithChildren) =>
      React.createElement("linearGradient", props, ...(children != null ? [children] : [])),
    Path: (props: Record<string, unknown>) => React.createElement("path", props),
    Polyline: (props: Record<string, unknown>) => React.createElement("polyline", props),
    Rect: (props: Record<string, unknown>) => React.createElement("rect", props),
    Stop: (props: Record<string, unknown>) => React.createElement("stop", props),
    Text: ({ children, ...props }: MockPropsWithChildren) =>
      React.createElement("text", props, ...(children != null ? [children] : [])),
  };
}

export function defaultObserver<T>(data: T) {
  return { data, isLoading: false, isFetching: false, isPlaceholderData: false, error: null };
}

export function resetActivityDetailMocks(options: {
  activity: unknown;
  stream: unknown;
  routeParams: { id: string };
  routeMap: { mockClear: () => void };
  alert: { mockClear: () => void };
  capture: { mockClear: () => void };
  routeId: string;
}) {
  const mocks = routeMocks;
  chartScrub.startedAt = null;
  chartScrub.endedAt = null;
  chartScrub.onHoverTime = null;
  chartScrub.onScrubStart = null;
  chartScrub.onScrubEnd = null;
  options.routeParams.id = options.routeId;
  mocks.restoreProviderAbsentMutate.mockClear();
  mocks.restoreResult.mockReturnValue(undefined);
  mocks.restoreStatus.mockReturnValue({ data: undefined, error: null });
  mocks.hardwareRefetch.mockClear();
  mocks.hardwareQuery.mockReturnValue({
    data: { items: [], power: [] },
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    error: null,
    refetch: mocks.hardwareRefetch,
  });
  mocks.metricSourcesQuery.mockReturnValue(defaultObserver([]));
  options.routeMap.mockClear();
  mocks.byIdQuery.mockClear();
  mocks.imagesQuery.mockReset();
  mocks.imagesQuery.mockReturnValue({
    data: { images: [], coverage: [], acquisition: [] },
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    error: null,
    refetch: vi.fn(),
  });
  mocks.streamQuery.mockReset();
  mocks.heartRateContextQuery.mockReset();
  mocks.heartRateContextQuery.mockReturnValue(defaultObserver(undefined));
  mocks.routeQuery.mockReset();
  mocks.routeQuery.mockReturnValue({
    data: { status: "unavailable" },
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    error: null,
  });
  mocks.hrZonesQuery.mockReset();
  mocks.powerZonesQuery.mockReset();
  mocks.powerWorkQuery.mockReset();
  mocks.powerWorkQuery.mockReturnValue({
    data: { workKilojoules: null, coverage: { coveredSeconds: 0, coveragePct: 0 } },
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    error: null,
  });
  mocks.strengthExercisesQuery.mockReset();
  mocks.climbingEntriesQuery.mockReset();
  mocks.climbingEntriesQuery.mockReturnValue(defaultObserver([]));
  mocks.entrySuggestionsQuery.mockReset();
  mocks.entrySuggestionsQuery.mockReturnValue(defaultObserver([]));
  mocks.hangboardDetailsQuery.mockReset();
  mocks.hangboardDetailsQuery.mockReturnValue(defaultObserver(undefined));
  mocks.deleteMutate.mockClear();
  mocks.attachEntryMutate.mockClear();
  mocks.activityByIdInvalidate.mockClear();
  mocks.activityInvalidate.mockClear();
  mocks.activityStreamInvalidate.mockClear();
  mocks.activityHrZonesInvalidate.mockClear();
  mocks.activityPowerZonesInvalidate.mockClear();
  mocks.activityPowerWorkInvalidate.mockClear();
  mocks.activityStrengthExercisesInvalidate.mockClear();
  mocks.activityHangboardDetailsInvalidate.mockClear();
  mocks.activityListInvalidate.mockClear();
  mocks.activityImagesInvalidate.mockClear();
  mocks.climbingEntriesInvalidate.mockClear();
  mocks.entrySuggestionsInvalidate.mockClear();
  mocks.climbingSessionSummaryInvalidate.mockClear();
  mocks.mobileTrainingInvalidate.mockClear();
  mocks.climbingStrengthsInvalidate.mockClear();
  mocks.climbingVolumeByGradeInvalidate.mockClear();
  mocks.calendarWeekListInvalidate.mockClear();
  mocks.calendarActivityOverviewInvalidate.mockClear();
  mocks.calendarDataInvalidate.mockClear();
  mocks.routerBack.mockClear();
  mocks.routerPush.mockClear();
  options.alert.mockClear();
  options.capture.mockClear();
  mocks.byIdQuery.mockReturnValue(defaultObserver(options.activity));
  mocks.streamQuery.mockReturnValue(defaultObserver(options.stream));
  mocks.hrZonesQuery.mockReturnValue(defaultObserver([]));
  mocks.powerZonesQuery.mockReturnValue(defaultObserver(null));
  mocks.strengthExercisesQuery.mockReturnValue(defaultObserver([]));
}

export function makeTrpcMock() {
  const mocks = routeMocks;
  return {
    trpc: {
      activity: {
        images: { useQuery: (...args: unknown[]) => mocks.imagesQuery(...args) },
        byId: { useQuery: (...args: unknown[]) => mocks.byIdQuery(...args) },
        metricSources: { useQuery: (...args: unknown[]) => mocks.metricSourcesQuery(...args) },
        hardware: { useQuery: (...args: unknown[]) => mocks.hardwareQuery(...args) },
        stream: { useQuery: (...args: unknown[]) => mocks.streamQuery(...args) },
        heartRateContext: {
          useQuery: (...args: unknown[]) => mocks.heartRateContextQuery(...args),
        },
        route: { useQuery: (...args: unknown[]) => mocks.routeQuery(...args) },
        hrZones: { useQuery: (...args: unknown[]) => mocks.hrZonesQuery(...args) },
        powerZones: { useQuery: (...args: unknown[]) => mocks.powerZonesQuery(...args) },
        powerWork: { useQuery: (...args: unknown[]) => mocks.powerWorkQuery(...args) },
        strengthExercises: {
          useQuery: (...args: unknown[]) => mocks.strengthExercisesQuery(...args),
        },
        hangboardDetails: {
          useQuery: (...args: unknown[]) => mocks.hangboardDetailsQuery(...args),
        },
        recompute: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
        recomputeStatus: { useQuery: () => ({ data: undefined, error: null }) },
        delete: {
          useMutation: (options?: { onSuccess?: () => Promise<void> }) => ({
            mutate: (input: { id: string }) => {
              mocks.deleteMutate(input);
              void options?.onSuccess?.();
            },
            isPending: false,
          }),
        },
        restoreStatus: { useQuery: mocks.restoreStatus },
        restoreProviderAbsent: {
          useMutation: (options?: {
            onSuccess?: () => Promise<void>;
            onError?: (error: Error) => void;
          }) => ({
            mutate: (input: { ids: string[] }) => {
              mocks.restoreProviderAbsentMutate(input);
              void options?.onSuccess?.();
            },
            data: mocks.restoreResult(),
            isPending: false,
            error: null,
            reset: vi.fn(),
          }),
        },
      },
      climbing: {
        activityLogEntries: {
          useQuery: (...args: unknown[]) => mocks.climbingEntriesQuery(...args),
        },
        unattachedClimbingLogEntries: {
          useQuery: (...args: unknown[]) => mocks.entrySuggestionsQuery(...args),
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
              mocks.attachEntryMutate(input);
              void options?.onSuccess?.({ attached: true }, input);
              callbacks?.onSuccess?.();
            },
            isPending: false,
          }),
        },
      },
      useUtils: () => ({
        mobileDashboard: { trainingV2: { invalidate: mocks.mobileTrainingInvalidate } },
        activity: {
          invalidate: mocks.activityInvalidate,
          images: { invalidate: mocks.activityImagesInvalidate },
          byId: { invalidate: mocks.activityByIdInvalidate },
          stream: { invalidate: mocks.activityStreamInvalidate },
          heartRateContext: { invalidate: vi.fn().mockResolvedValue(undefined) },
          hrZones: { invalidate: mocks.activityHrZonesInvalidate },
          powerZones: { invalidate: mocks.activityPowerZonesInvalidate },
          powerWork: { invalidate: mocks.activityPowerWorkInvalidate },
          strengthExercises: { invalidate: mocks.activityStrengthExercisesInvalidate },
          hangboardDetails: { invalidate: mocks.activityHangboardDetailsInvalidate },
          list: { invalidate: mocks.activityListInvalidate },
        },
        calendar: {
          weekListV2: { invalidate: mocks.calendarWeekListInvalidate },
          activityOverview: { invalidate: mocks.calendarActivityOverviewInvalidate },
          calendarData: { invalidate: mocks.calendarDataInvalidate },
        },
        climbing: {
          activityLogEntries: { invalidate: mocks.climbingEntriesInvalidate },
          unattachedClimbingLogEntries: { invalidate: mocks.entrySuggestionsInvalidate },
          sessionSummary: { invalidate: mocks.climbingSessionSummaryInvalidate },
          strengths: { invalidate: mocks.climbingStrengthsInvalidate },
          volumeByGrade: { invalidate: mocks.climbingVolumeByGradeInvalidate },
          attemptIncrease: { invalidate: vi.fn().mockResolvedValue(undefined) },
        },
      }),
    },
  };
}

export function mockGarminHeartRateFailure(streamPoints: unknown) {
  const originalStream = routeMocks.streamQuery.getMockImplementation();
  let garminReadFailed = false;
  routeMocks.streamQuery.mockImplementation((input?: unknown, options?: unknown) => {
    if (
      input &&
      typeof input === "object" &&
      "sources" in input &&
      input.sources &&
      typeof input.sources === "object" &&
      "heartRate" in input.sources &&
      input.sources.heartRate === "garmin"
    ) {
      if (!garminReadFailed) {
        return {
          data: streamPoints,
          error: null,
          isLoading: false,
          isFetching: true,
          isPlaceholderData: true,
        };
      }
      return {
        data: undefined,
        error: new Error("Garmin samples could not be read"),
        isLoading: false,
        isFetching: false,
        isPlaceholderData: false,
      };
    }
    return originalStream?.(input, options) ?? defaultObserver([]);
  });
  return () => {
    garminReadFailed = true;
  };
}
