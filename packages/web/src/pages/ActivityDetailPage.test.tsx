import type { ActivityMetricSources } from "../../../server/src/contracts/activity-metric-sources.ts";
import type { ClimbingLogEntryDetail } from "../../../server/src/contracts/climbing-log-contracts.ts";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../server/src/repositories/climbing-test-helpers.ts";
/** @vitest-environment jsdom */

import { formatDateTime, formatTimeOnly } from "@dofek/format/format";
import type { UnitSystem } from "@dofek/format/units";
import { UnitConverter } from "@dofek/format/units";
import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityDetail } from "../../../server/src/models/activity.ts";
import type { StrengthExerciseDetail } from "../../../server/src/routers/activity.ts";
import {
  sourceHardware,
  strongSourceTree,
} from "../components/ActivitySourceDisclosure.fixtures.ts";
import { UnitContext } from "../lib/unitContext.ts";
import { detailSourceTree, removedDetailSourceTree } from "./ActivityDetailPage.fixtures.ts";

const capturedOptions: Array<Record<string, unknown>> = [];
const capturedEvents: Array<Record<string, (...params: Array<Record<string, unknown>>) => void>> =
  [];

const leafletMocks = vi.hoisted(() => ({
  map: vi.fn((container: HTMLElement) => ({
    remove: vi.fn(() => container.replaceChildren()),
    fitBounds: vi.fn(),
    container,
  })),
  tileLayer: vi.fn(() => ({
    addTo: vi.fn(),
    on: vi.fn(),
    once: vi.fn((_event: string, onLoad: () => void) => onLoad()),
  })),
  latLng: vi.fn((lat: number, lng: number) => ({ lat, lng })),
  latLngBounds: vi.fn(() => ({})),
  polyline: vi.fn(() => ({ addTo: vi.fn() })),
  circleMarker: vi.fn(() => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.append(element);
    const marker = {
      addTo: vi.fn((map: { container: HTMLElement }) => {
        map.container.append(svg);
        return marker;
      }),
      remove: vi.fn(),
      setLatLng: vi.fn(),
      bindTooltip: vi.fn(() => marker),
      on: vi.fn((event: string, listener: () => void) => {
        element.addEventListener(event, listener);
        return marker;
      }),
      fire: vi.fn((event: string) => {
        element.dispatchEvent(new Event(event));
        return marker;
      }),
      getElement: vi.fn(() => element),
      openTooltip: vi.fn(),
      closeTooltip: vi.fn(),
    };
    return marker;
  }),
}));

vi.mock("echarts-for-react", () => ({
  default: (props: {
    option: Record<string, unknown>;
    onEvents?: Record<string, (...params: Array<Record<string, unknown>>) => void>;
  }) => {
    capturedOptions.push(props.option);
    if (props.onEvents) capturedEvents.push(props.onEvents);
    return <div data-testid="echarts" />;
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ id: "test-123" }),
  useNavigate: () => vi.fn(),
  Link: ({ children, ...props }: { children: ReactNode; to: string }) => (
    <a href={props.to}>{children}</a>
  ),
}));

const mockActivity: ActivityDetail & { displayedDate?: string } = {
  id: "test-123",
  displayedDate: "2026-03-18",
  notes: null,
  perceivedExertion: null,
  maxSpeed: null,
  maxSpeedState: { status: "missing", reason: "Max Speed not recorded" },
  elevationLoss: null,
  elevationLossState: { status: "missing", reason: "Elevation Loss not recorded" },
  sampleCount: null,
  sampleCountState: { status: "missing", reason: "Sample Count not recorded" },
  name: "Morning Run",
  activityType: "running",
  rawType: "running",
  modality: null,
  startedAt: "2026-03-18T07:00:00Z",
  endedAt: "2026-03-18T07:45:00Z",
  localTimeContext: {
    timezone: null,
    startUtcOffsetMinutes: 60,
    endUtcOffsetMinutes: 60,
    source: "provider_offset",
  },
  providerId: "whoop",
  subsource: null,
  providerAbsentAt: null,
  totalDistance: 10000,
  totalDistanceState: { status: "available" },
  elevationGain: 200,
  elevationGainState: { status: "available" },
  avgHr: 150,
  avgHrState: { status: "available" },
  maxHr: 175,
  maxHrState: { status: "available" },
  avgPower: null,
  avgPowerState: { status: "missing", reason: "Avg Power not recorded" },
  maxPower: null,
  maxPowerState: { status: "missing", reason: "Max Power not recorded" },
  avgSpeed: 3.0,
  avgSpeedState: { status: "available" },
  avgCadence: null,
  avgCadenceState: { status: "missing", reason: "Avg Cadence not recorded" },
  sourceProviders: ["whoop", "apple_health"],
  sourceLinks: [],
  sourceTree: { primary: null, otherSources: [] },
  sourceDecision: null,
};

const mockStreamPoints: Array<{
  recordedAt: string;
  lat: number | null;
  lng: number | null;
  heartRate: number | null;
  power: number | null;
  speed: number | null;
  cadence: number | null;
  altitude: number | null;
}> = [
  {
    recordedAt: "2026-03-18T07:00:00Z",
    lat: 1,
    lng: 1,
    heartRate: 140,
    power: null,
    speed: 3.0,
    cadence: null,
    altitude: 100,
  },
  {
    recordedAt: "2026-03-18T07:15:00Z",
    lat: 1.1,
    lng: 1.1,
    heartRate: 155,
    power: null,
    speed: 3.5,
    cadence: null,
    altitude: 250,
  },
  {
    recordedAt: "2026-03-18T07:30:00Z",
    lat: 1.2,
    lng: 1.2,
    heartRate: 160,
    power: null,
    speed: 2.8,
    cadence: null,
    altitude: 400,
  },
];
const initialMockStreamPoints = mockStreamPoints.map((point) => ({ ...point }));

interface MockQueryResult<T> {
  data: T | undefined;
  error: Error | null;
  isError: boolean;
  isLoading: boolean;
}

const mockActivityByIdUseQuery = vi.fn<
  () => MockQueryResult<ActivityDetail> & { error: (Error & { data?: { code?: string } }) | null }
>(() => ({
  data: mockActivity,
  error: null,
  isError: false,
  isLoading: false,
}));
const mockStrengthExercisesUseQuery = vi.fn(
  (_input?: unknown, _options?: { enabled?: boolean }): MockQueryResult<unknown[]> => ({
    data: [],
    error: null,
    isError: false,
    isLoading: false,
  }),
);
const mockHangboardDetailsUseQuery = vi.fn(
  (_input?: unknown, _options?: { enabled?: boolean }): MockQueryResult<unknown> => ({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
  }),
);
const mockClimbingEntriesUseQuery = vi.fn(
  (
    _input?: unknown,
    _options?: { enabled?: boolean },
  ): {
    data: ClimbingLogEntryDetail[] | undefined;
    error: Error | null;
    isError: boolean;
    isLoading: boolean;
  } => ({
    data: [],
    error: null,
    isError: false,
    isLoading: false,
  }),
);
const mockEntrySuggestionsUseQuery = vi.fn(
  (
    _input?: unknown,
    _options?: { enabled?: boolean },
  ): {
    data: ClimbingLogEntryDetail[] | undefined;
    error: unknown | null;
    isLoading: boolean;
  } => ({
    data: [],
    error: null,
    isLoading: false,
  }),
);
const mockAttachEntryMutate = vi.fn();
const mockAttachShouldFail = vi.fn(() => false);
const mockClimbingEntriesInvalidate = vi.fn().mockResolvedValue(undefined);
const mockEntrySuggestionsInvalidate = vi.fn().mockResolvedValue(undefined);
const mockClimbingSessionSummaryInvalidate = vi.fn().mockResolvedValue(undefined);
const mockClimbingGradeProgressionInvalidate = vi.fn().mockResolvedValue(undefined);
const mockClimbingVolumeByGradeInvalidate = vi.fn().mockResolvedValue(undefined);

interface MockHrZone {
  zone: number;
  label: string;
  minPct: number;
  maxPct: number;
  seconds: number;
  percent: number;
}

interface MockPowerZone {
  zone: number;
  label: string;
  minPct: number;
  maxPct: number | null;
  seconds: number;
  percent: number;
}

interface MockPowerZonesResult {
  ftp: number;
  zones: MockPowerZone[];
}

interface MockHrZonesResult {
  data: MockHrZone[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

function defaultMockHrZonesResult(): MockHrZonesResult {
  return {
    data: [],
    isLoading: false,
    isError: false,
    error: null,
  };
}

const mockHrZonesUseQuery = vi.fn(
  (_input?: unknown, _options?: unknown): MockHrZonesResult => defaultMockHrZonesResult(),
);
const mockStreamUseQuery = vi.fn(
  (_input?: unknown, _options?: unknown): MockQueryResult<typeof mockStreamPoints> => ({
    data: mockStreamPoints,
    error: null,
    isError: false,
    isLoading: false,
  }),
);
type MockRouteData =
  | { status: "processing" | "unavailable" }
  | { status: "ready"; points: Array<{ lat: number | null; lng: number | null }> };
const mockRouteUseQuery = vi.fn(
  (
    _input?: unknown,
    _options?: unknown,
  ): {
    data: MockRouteData;
    error: Error | null;
    isLoading: boolean;
  } => ({
    data: {
      status: "ready",
      points: mockStreamPoints.map((point) => ({ lat: point.lat, lng: point.lng })),
    },
    error: null,
    isLoading: false,
  }),
);
const mockPowerZonesUseQuery = vi.fn(
  (_input?: unknown, _options?: { enabled?: boolean }): MockQueryResult<MockPowerZonesResult> => ({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
  }),
);
const mockMetricSourcesUseQuery = vi.fn(
  (): MockQueryResult<ActivityMetricSources> => ({
    data: [],
    error: null,
    isError: false,
    isLoading: false,
  }),
);
const mockRecomputeMutate = vi.fn();
const mockHardwareUseQuery = vi.fn(
  (): {
    data: ActivityHardware;
    isLoading: boolean;
    error: Error | null;
    refetch: () => void;
  } => ({ data: { items: [], power: [] }, isLoading: false, error: null, refetch: vi.fn() }),
);
const mockImagesUseQuery = vi.fn(() => ({
  data: { images: [], coverage: [], acquisition: [] },
  error: null,
  isLoading: false,
  isFetching: false,
  refetch: vi.fn(),
}));
const mockRecomputeShouldFail = vi.fn(() => false);
const mockActivityByIdInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityStreamInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityHrZonesInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityPowerZonesInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityStrengthExercisesInvalidate = vi.fn().mockResolvedValue(undefined);
const mockActivityListInvalidate = vi.fn().mockResolvedValue(undefined);
const mockCalendarWeekListInvalidate = vi.fn().mockResolvedValue(undefined);
const mockCalendarActivityOverviewInvalidate = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    activity: {
      images: { useQuery: mockImagesUseQuery },
      byId: { useQuery: mockActivityByIdUseQuery },
      stream: { useQuery: mockStreamUseQuery },
      metricSources: { useQuery: mockMetricSourcesUseQuery },
      hardware: { useQuery: mockHardwareUseQuery },
      route: { useQuery: mockRouteUseQuery },
      hrZones: { useQuery: mockHrZonesUseQuery },
      powerZones: { useQuery: mockPowerZonesUseQuery },
      strengthExercises: { useQuery: mockStrengthExercisesUseQuery },
      hangboardDetails: { useQuery: mockHangboardDetailsUseQuery },
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
    },
    climbing: {
      activityLogEntries: { useQuery: mockClimbingEntriesUseQuery },
      unattachedClimbingLogEntries: { useQuery: mockEntrySuggestionsUseQuery },
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
            if (mockAttachShouldFail()) {
              const error = new Error("This climbing entry is no longer available.");
              options?.onError?.(error, input);
              callbacks?.onError?.(error);
              return;
            }
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
        list: { invalidate: mockActivityListInvalidate },
      },
      calendar: {
        weekList: { invalidate: mockCalendarWeekListInvalidate },
        activityOverview: { invalidate: mockCalendarActivityOverviewInvalidate },
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

vi.mock("leaflet", () => leafletMocks);

vi.mock("react-body-highlighter", () => ({
  default: ({ type }: { type: string }) => <div data-testid={`muscle-map-${type}`} />,
  MuscleType: {
    BACK_DELTOIDS: "back_deltoids",
    CHEST: "chest",
    FRONT_DELTOIDS: "front_deltoids",
  },
}));

afterEach(() => {
  mockHardwareUseQuery.mockReset();
  mockHardwareUseQuery.mockReturnValue({
    data: { items: [], power: [] },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  mockMetricSourcesUseQuery.mockReset();
  mockMetricSourcesUseQuery.mockReturnValue({
    data: [],
    error: null,
    isError: false,
    isLoading: false,
  });
  mockActivityByIdUseQuery.mockReset();
  mockActivityByIdUseQuery.mockReturnValue({
    data: mockActivity,
    error: null,
    isError: false,
    isLoading: false,
  });
  mockStreamUseQuery.mockClear();
  mockStreamUseQuery.mockImplementation((_input?: unknown, _options?: unknown) => ({
    data: mockStreamPoints,
    error: null,
    isError: false,
    isLoading: false,
  }));
  mockRouteUseQuery.mockReset();
  mockRouteUseQuery.mockImplementation((_input?: unknown, _options?: unknown) => ({
    data: {
      status: "ready",
      points: mockStreamPoints.map((point) => ({ lat: point.lat, lng: point.lng })),
    },
    error: null,
    isLoading: false,
  }));
  mockHrZonesUseQuery.mockReset();
  mockHrZonesUseQuery.mockImplementation(
    (_input?: unknown, _options?: unknown): MockHrZonesResult => defaultMockHrZonesResult(),
  );
  mockClimbingEntriesUseQuery.mockReset();
  mockClimbingEntriesUseQuery.mockReturnValue({
    data: [],
    error: null,
    isError: false,
    isLoading: false,
  });
  mockEntrySuggestionsUseQuery.mockReset();
  mockEntrySuggestionsUseQuery.mockReturnValue({ data: [], error: null, isLoading: false });
  mockAttachEntryMutate.mockClear();
  mockAttachShouldFail.mockReset();
  mockAttachShouldFail.mockReturnValue(false);
  mockClimbingEntriesInvalidate.mockClear();
  mockEntrySuggestionsInvalidate.mockClear();
  mockClimbingSessionSummaryInvalidate.mockClear();
  mockClimbingGradeProgressionInvalidate.mockClear();
  mockClimbingVolumeByGradeInvalidate.mockClear();
  mockStrengthExercisesUseQuery.mockReset();
  mockStrengthExercisesUseQuery.mockReturnValue({
    data: [],
    error: null,
    isError: false,
    isLoading: false,
  });
  mockHangboardDetailsUseQuery.mockReset();
  mockHangboardDetailsUseQuery.mockReturnValue({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
  });
  mockPowerZonesUseQuery.mockReset();
  mockPowerZonesUseQuery.mockReturnValue({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
  });
  mockStreamPoints.splice(
    0,
    mockStreamPoints.length,
    ...initialMockStreamPoints.map((point) => ({ ...point })),
  );
});

function renderWithUnits(ui: ReactNode, unitSystem: UnitSystem = "metric") {
  capturedOptions.length = 0;
  capturedEvents.length = 0;
  leafletMocks.map.mockClear();
  leafletMocks.tileLayer.mockClear();
  leafletMocks.latLng.mockClear();
  leafletMocks.latLngBounds.mockClear();
  leafletMocks.polyline.mockClear();
  leafletMocks.circleMarker.mockClear();
  mockStrengthExercisesUseQuery.mockClear();
  mockHangboardDetailsUseQuery.mockClear();
  mockClimbingEntriesUseQuery.mockClear();
  mockHrZonesUseQuery.mockClear();
  mockPowerZonesUseQuery.mockClear();
  mockRecomputeMutate.mockClear();
  mockRecomputeShouldFail.mockReset();
  mockRecomputeShouldFail.mockReturnValue(false);
  mockActivityByIdInvalidate.mockClear();
  mockActivityStreamInvalidate.mockClear();
  mockActivityHrZonesInvalidate.mockClear();
  mockActivityPowerZonesInvalidate.mockClear();
  mockActivityStrengthExercisesInvalidate.mockClear();
  mockActivityListInvalidate.mockClear();
  mockCalendarWeekListInvalidate.mockClear();
  mockCalendarActivityOverviewInvalidate.mockClear();
  return render(
    <UnitContext.Provider value={{ unitSystem, setUnitSystem: () => {} }}>
      {ui}
    </UnitContext.Provider>,
  );
}

function findOptionByYAxisName(name: string): Record<string, unknown> | undefined {
  return capturedOptions.find((opt) => {
    const yAxis = opt.yAxis;
    if (yAxis && typeof yAxis === "object" && "name" in yAxis) {
      return String(yAxis.name).includes(name);
    }
    return false;
  });
}

function findOptionByYAxisArrayName(name: string): Record<string, unknown> | undefined {
  return capturedOptions.find((opt) => {
    const yAxes = opt.yAxis;
    if (!Array.isArray(yAxes)) return false;
    return yAxes.some(
      (y: Record<string, unknown>) => typeof y.name === "string" && y.name.includes(name),
    );
  });
}

function getSliderDataZoom(opt: Record<string, unknown>): Record<string, unknown> | undefined {
  const dataZoom = opt.dataZoom;
  if (!Array.isArray(dataZoom)) return undefined;
  return dataZoom.find(
    (zoom): zoom is Record<string, unknown> =>
      typeof zoom === "object" && zoom !== null && Reflect.get(zoom, "type") === "slider",
  );
}

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

function getSeriesData(opt: Record<string, unknown>): Array<unknown> {
  const series = opt.series;
  if (Array.isArray(series) && series[0] && typeof series[0] === "object" && "data" in series[0]) {
    return series[0].data.map((datum: unknown) => {
      if (typeof datum !== "object" || datum === null || !("value" in datum)) return datum;
      return Array.isArray(datum.value) ? datum.value[1] : datum.value;
    });
  }
  return [];
}

function getYAxisName(opt: Record<string, unknown>): string {
  const yAxis = opt.yAxis;
  if (yAxis && typeof yAxis === "object" && "name" in yAxis) {
    return String(yAxis.name);
  }
  return "";
}

function getCategoryAxisData(opt: Record<string, unknown>): string[] {
  const yAxis = opt.yAxis;
  if (!yAxis || typeof yAxis !== "object") {
    return [];
  }

  const data = Reflect.get(yAxis, "data");
  return Array.isArray(data) ? data.map((label) => String(label)) : [];
}

function getCategoryAxisLabelOptions(opt: Record<string, unknown>): Record<string, unknown> {
  const yAxis = opt.yAxis;
  if (!yAxis || typeof yAxis !== "object") {
    return {};
  }

  const axisLabel = Reflect.get(yAxis, "axisLabel");
  return axisLabel && typeof axisLabel === "object" ? axisLabel : {};
}

function formatCategoryAxisLabel(opt: Record<string, unknown>, value: string): string {
  const axisLabel = getCategoryAxisLabelOptions(opt);
  const formatter = Reflect.get(axisLabel, "formatter");
  return typeof formatter === "function" ? String(formatter(value)) : "";
}

function getYAxisShowOption(opt: Record<string, unknown>): unknown {
  const yAxis = opt.yAxis;
  if (!yAxis || typeof yAxis !== "object") {
    return undefined;
  }

  return Reflect.get(yAxis, "show");
}

function getGridLeftOption(opt: Record<string, unknown>): unknown {
  const grid = opt.grid;
  if (!grid || typeof grid !== "object") {
    return undefined;
  }

  return Reflect.get(grid, "left");
}

function findOptionByYAxisDataLabel(label: string): Record<string, unknown> | undefined {
  return capturedOptions.find((option) => getCategoryAxisData(option).includes(label));
}

async function importPage() {
  const mod = await import("./ActivityDetailPage.tsx");
  return mod.ActivityDetailPage;
}

async function importActivityHeader() {
  const mod = await import("./ActivityDetailPage.tsx");
  return mod.ActivityHeader;
}

describe("ActivityDetailPage", () => {
  it("requests downloaded photos for the current activity with signed-link renewal", async () => {
    const { ActivityDetailPage } = await import("./ActivityDetailPage.tsx");
    renderWithUnits(<ActivityDetailPage />);
    expect(mockImagesUseQuery).toHaveBeenCalledWith(
      { id: "test-123" },
      expect.objectContaining({ refetchOnMount: "always", refetchOnWindowFocus: true }),
    );
  });
  it("shows a loading skeleton before activity details resolve", async () => {
    mockActivityByIdUseQuery.mockReturnValue({
      data: undefined,
      error: null,
      isError: false,
      isLoading: true,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByTestId("chart-loading-skeleton")).toBeTruthy();
    expect(screen.queryByText("Activity not found")).toBeNull();
  });

  it("keeps removed source records visible without links while retaining active sources", async () => {
    mockActivityByIdUseQuery.mockReturnValue({
      data: {
        ...mockActivity,
        sourceTree: removedDetailSourceTree,
      },
      error: null,
      isError: false,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "Garmin Edge 530 Sources" }));
    expect(screen.getByText("Closest available recording · Removed from provider")).toBeVisible();
    expect(screen.getByText("Imported from Garmin Connect · Removed from provider")).toBeVisible();
    expect(screen.getByText("Strava").closest("a")).toBeNull();
    expect(screen.queryByRole("link", { name: "View activity for Garmin Edge 530" })).toBeNull();
    expect(screen.getByRole("link", { name: "WHOOP" })).toHaveAttribute(
      "href",
      "https://app.whoop.com/activities/123",
    );
  });

  it("shows the primary server error instead of reporting a missing activity", async () => {
    mockActivityByIdUseQuery.mockReturnValue({
      data: undefined,
      error: Object.assign(new Error("Activity database is unavailable."), {
        data: { code: "INTERNAL_SERVER_ERROR" },
      }),
      isError: true,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Activity database is unavailable.")).toBeDefined();
    expect(screen.queryByText("Activity not found")).toBeNull();
  });

  it("keeps activity details visible while reporting a background refresh failure", async () => {
    mockActivityByIdUseQuery.mockReturnValue({
      data: mockActivity,
      error: new Error("Activity details refresh failed."),
      isError: true,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByRole("heading", { name: "Morning Run" })).toBeDefined();
    expect(screen.getByText("Activity details refresh failed.")).toBeDefined();
  });

  it("uses the not-found state only for a NOT_FOUND response", async () => {
    mockActivityByIdUseQuery.mockReturnValue({
      data: undefined,
      error: Object.assign(new Error("Activity not found"), {
        data: { code: "NOT_FOUND" },
      }),
      isError: true,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Activity not found")).toBeDefined();
  });

  it("hides an unrecorded detail metric and preserves a measured zero", async () => {
    mockActivityByIdUseQuery.mockReturnValue({
      data: {
        ...mockActivity,
        totalDistance: null,
        totalDistanceState: { status: "missing", reason: "Distance not recorded" },
      },
      error: null,
      isError: false,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    const { rerender } = renderWithUnits(<ActivityDetailPage />);

    expect(screen.queryByText("Distance unavailable")).toBeNull();
    expect(screen.queryByText("Distance not recorded")).toBeNull();

    mockActivityByIdUseQuery.mockReturnValue({
      data: { ...mockActivity, totalDistance: 0, totalDistanceState: { status: "available" } },
      error: null,
      isError: false,
      isLoading: false,
    });
    rerender(<ActivityDetailPage />);

    expect(screen.getByText("0.0 km")).toBeDefined();
    expect(screen.getByText("0.0 km")).toBeDefined();
  });

  it("renders an activity header without optional name or source metadata", async () => {
    const ActivityHeader = await importActivityHeader();
    renderWithUnits(
      <ActivityHeader
        activity={{
          ...mockActivity,
          name: null,
          sourceLinks: [],
          sourceProviders: [],
          sourceTree: { primary: null, otherSources: [] },
        }}
        units={new UnitConverter("metric")}
      />,
    );

    expect(screen.getByRole("heading", { name: "running" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Sources/ })).toBeNull();
    expect(screen.getByText("10.0 km")).toBeVisible();
  });

  it("renders the server-provided calendar date at a UTC boundary", async () => {
    const ActivityHeader = await importActivityHeader();
    renderWithUnits(
      <ActivityHeader
        activity={{
          ...mockActivity,
          startedAt: "2026-03-18T00:30:00.000Z",
          displayedDate: "2026-03-18",
          localTimeContext: {
            timezone: null,
            startUtcOffsetMinutes: 120,
            endUtcOffsetMinutes: 120,
            source: "provider_offset",
          },
        }}
        units={new UnitConverter("metric")}
      />,
    );

    expect(screen.getByText(/Wed, Mar 18, 2026 at/)).toBeDefined();
  });

  it("omits duration for an activity that has not ended", async () => {
    const ActivityHeader = await importActivityHeader();
    renderWithUnits(
      <ActivityHeader
        activity={{ ...mockActivity, endedAt: null }}
        units={new UnitConverter("metric")}
      />,
    );

    expect(screen.queryByText("Duration")).toBeNull();
    expect(screen.getByText("10.0 km")).toBeDefined();
  });

  it("shows a sensor section error when the stream query fails without data", async () => {
    mockStreamUseQuery.mockReturnValue({
      data: undefined,
      error: new Error("Sensor stream is unavailable."),
      isError: true,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Sensor stream is unavailable.")).toBeDefined();
  });

  it("keeps cached stream charts visible during a background refresh error", async () => {
    mockStreamUseQuery.mockReturnValue({
      data: mockStreamPoints,
      error: new Error("Sensor stream refresh failed."),
      isError: true,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Performance")).toBeDefined();
    expect(screen.getByText("Sensor stream refresh failed.")).toBeDefined();
  });

  it("renders loading placeholders for cached sensor charts during an active fetch", async () => {
    mockStreamUseQuery.mockReturnValue({
      data: mockStreamPoints,
      error: null,
      isError: false,
      isLoading: true,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getAllByTestId("chart-loading-skeleton")).toHaveLength(2);
  });

  it("does not bind chart hover events when stream points have no GPS coordinates", async () => {
    mockStreamUseQuery.mockReturnValue({
      data: mockStreamPoints.map((point) => ({ ...point, lat: null, lng: null })),
      error: null,
      isError: false,
      isLoading: false,
    });
    mockRouteUseQuery.mockReturnValue({
      data: { status: "ready", points: [] },
      error: null,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.queryByText("Route Map")).toBeNull();
    const metricEvents = capturedEvents.find((events) => events.legendselectchanged != null);
    expect(metricEvents?.updateAxisPointer).toBeUndefined();
  });

  it("shows route processing instead of drawing cached partial GPS", async () => {
    mockRouteUseQuery.mockReturnValue({
      data: { status: "processing" },
      error: null,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Processing route map…")).toBeDefined();
    expect(screen.getByRole("status").parentElement).toHaveClass("h-[400px]");
    expect(screen.getByRole("status").querySelector(".animate-spin")).not.toBeNull();
    expect(leafletMocks.tileLayer).not.toHaveBeenCalled();
    const routeOptions = mockRouteUseQuery.mock.calls[0]?.[1];
    if (
      !routeOptions ||
      typeof routeOptions !== "object" ||
      !("refetchInterval" in routeOptions) ||
      typeof routeOptions.refetchInterval !== "function"
    ) {
      throw new Error("Expected activity route polling option");
    }
    expect(routeOptions.refetchInterval({ state: { data: { status: "processing" } } })).toBe(3000);
    expect(routeOptions.refetchInterval({ state: { data: { status: "ready" } } })).toBe(false);
  });

  it.each([
    "unavailable",
    "loading",
    "processing",
    "error",
    "cached error",
    "cached loading",
  ] as const)("shows canonical climbing locations when the recorded route is %s", async (state) => {
    mockActivityByIdUseQuery.mockReturnValue({
      data: { ...mockActivity, activityType: "climbing" },
      error: null,
      isError: false,
      isLoading: false,
    });
    mockRouteUseQuery.mockReturnValue({
      data: state.startsWith("cached")
        ? { status: "ready", points: [{ lat: 7, lng: 8 }] }
        : { status: state === "processing" ? "processing" : "unavailable" },
      error: state.endsWith("error") ? new Error("Recorded route refresh failed") : null,
      isLoading: state.endsWith("loading"),
    });
    mockClimbingEntriesUseQuery.mockReturnValue({
      data: [
        climbingLogEntryFixture({ id: "unlocated", title: "Unknown location" }),
        climbingLogEntryFixture({
          id: "20000000-0000-4000-8000-000000000011",
          title: "Located climb",
          mapLocation: {
            coordinates: { latitude: 0, longitude: -122.25 },
            scope: "climb",
            objectId: "20000000-0000-4000-8000-000000000003",
            providerId: "mountain-project",
            name: "Located climb",
          },
        }),
      ],
      error: new Error("Climbing refresh failed"),
      isError: true,
      isLoading: false,
    });
    mockEntrySuggestionsUseQuery.mockReturnValue({
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
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getAllByRole("region", { name: "Climbing locations" })).toHaveLength(3);
    expect(screen.getByText("Climbing refresh failed")).toBeDefined();
    const climbPoint = await screen.findByRole("button", {
      name: "Located climb · Climb location: Located climb · Mountain Project",
    });
    const createdMaps = leafletMocks.map.mock.calls.length;
    act(() => climbPoint.focus());
    fireEvent.keyDown(climbPoint, { key: "Enter" });
    const dialog = await screen.findByRole("dialog");
    expect(
      within(within(dialog).getByRole("region", { name: "Climbing log details" })).getByText(
        "Located climb",
      ),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("region", { name: "Attached climbing logs", hidden: true })
        .querySelector('[aria-current="true"]'),
    ).toHaveAttribute("aria-current", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(climbPoint).toHaveFocus());
    fireEvent.click(climbPoint);
    expect(
      within(await screen.findByRole("dialog")).getByRole("region", {
        name: "Climbing log details",
      }),
    ).toBeInTheDocument();
    expect(leafletMocks.map).toHaveBeenCalledTimes(createdMaps);
    if (state.startsWith("cached")) {
      await waitFor(() => expect(leafletMocks.latLng).toHaveBeenCalledWith(7, 8));
    }
    if (state.endsWith("error")) {
      expect(screen.getByText("Recorded route refresh failed")).toBeDefined();
    }
  });

  it("shows a loading state before route freshness is known", async () => {
    mockRouteUseQuery.mockReturnValue({
      data: { status: "unavailable" },
      error: null,
      isLoading: true,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Loading route map…")).toBeDefined();
    expect(leafletMocks.tileLayer).not.toHaveBeenCalled();
  });

  it("shows a route-specific error instead of drawing cached partial GPS", async () => {
    mockRouteUseQuery.mockReturnValue({
      data: { status: "unavailable" },
      error: new Error("Route freshness query failed."),
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Route freshness query failed.")).toBeDefined();
    expect(leafletMocks.tileLayer).not.toHaveBeenCalled();
  });

  it("draws the ready route endpoint even when the cached sensor stream ends early", async () => {
    mockRouteUseQuery.mockReturnValue({
      data: {
        status: "ready",
        points: [
          { lat: 1, lng: 1 },
          { lat: 9, lng: 9 },
        ],
      },
      error: null,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    await waitFor(() => expect(leafletMocks.latLng).toHaveBeenCalledWith(9, 9));
  });

  it("shows OpenStreetMap tiles with attribution on the route map", async () => {
    const ActivityDetailPage = await importPage();
    renderWithUnits(<ActivityDetailPage />);

    await waitFor(() =>
      expect(leafletMocks.map).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({ attributionControl: true }),
      ),
    );
    expect(leafletMocks.tileLayer).toHaveBeenCalledWith(
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      expect.objectContaining({
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }),
    );
  });

  it("creates a route hover marker from valid chart pointer events", async () => {
    const ActivityDetailPage = await importPage();
    renderWithUnits(<ActivityDetailPage />);

    await waitFor(() => expect(leafletMocks.map).toHaveBeenCalledOnce());
    await waitFor(() => expect(leafletMocks.circleMarker).toHaveBeenCalledTimes(2));
    const metricEvents = capturedEvents.find((events) => events.updateAxisPointer != null);
    if (!metricEvents?.updateAxisPointer || !metricEvents.globalout) {
      throw new Error("Metrics chart pointer events were not registered");
    }

    metricEvents.updateAxisPointer({
      axesInfo: [{ value: Date.parse(mockStreamPoints[0]?.recordedAt ?? "") }],
    });
    await waitFor(() => expect(leafletMocks.circleMarker).toHaveBeenCalledTimes(3));

    metricEvents.updateAxisPointer({});
    metricEvents.updateAxisPointer({ axesInfo: [] });
    metricEvents.updateAxisPointer({ axesInfo: [{ value: -1 }] });
    metricEvents.updateAxisPointer({
      axesInfo: [{ value: Date.parse(mockStreamPoints.at(-1)?.recordedAt ?? "") + 1 }],
    });

    expect(leafletMocks.circleMarker).toHaveBeenCalledTimes(3);

    metricEvents.updateAxisPointer({
      axesInfo: [{ value: Date.parse(mockStreamPoints[1]?.recordedAt ?? "") }],
    });
    await waitFor(() => expect(leafletMocks.circleMarker).toHaveBeenCalledTimes(4));
    metricEvents.globalout();
  });

  it("hides sensor sections when no sensor measurements are available", async () => {
    mockStreamUseQuery.mockReturnValue({
      data: [
        {
          recordedAt: "2026-03-18T07:00:00Z",
          lat: null,
          lng: null,
          heartRate: null,
          power: null,
          speed: null,
          cadence: null,
          altitude: null,
        },
      ],
      error: null,
      isError: false,
      isLoading: false,
    });
    mockRouteUseQuery.mockReturnValue({
      data: { status: "unavailable" },
      error: null,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();
    renderWithUnits(<ActivityDetailPage />);

    expect(screen.queryByText("Route Map")).toBeNull();
    expect(screen.queryByText("Performance")).toBeNull();
    expect(screen.queryByText("Elevation Profile")).toBeNull();
    expect(screen.queryByText("Heart Rate Zones")).toBeNull();
  });

  it("applies only boolean legend selections to the metrics chart", async () => {
    const ActivityDetailPage = await importPage();
    renderWithUnits(<ActivityDetailPage />);

    const metricEvents = capturedEvents.find((events) => events.legendselectchanged != null);
    if (!metricEvents?.legendselectchanged) {
      throw new Error("Metrics chart legend event was not registered");
    }
    metricEvents.legendselectchanged({
      selected: { "Heart Rate": false, Speed: true, ignored: "not-a-boolean" },
    });

    await waitFor(() => {
      const metricOptions = capturedOptions.filter((option) => Array.isArray(option.yAxis));
      const latestOption = metricOptions.at(-1);
      if (!latestOption || !Array.isArray(latestOption.yAxis)) {
        throw new Error("Metrics chart option was not captured");
      }
      const heartRateAxis = latestOption.yAxis.find(
        (axis): axis is Record<string, unknown> =>
          typeof axis === "object" &&
          axis !== null &&
          Reflect.get(axis, "name") === "Heart Rate (bpm)",
      );
      expect(heartRateAxis?.show).toBe(false);
    });
  });

  it("shows a strength exercise section error", async () => {
    const originalActivity = { ...mockActivity };
    Object.assign(mockActivity, { activityType: "strength" });
    mockStrengthExercisesUseQuery.mockReturnValue({
      data: undefined,
      error: new Error("Strength exercises are unavailable."),
      isError: true,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Strength exercises are unavailable.")).toBeDefined();
    Object.assign(mockActivity, originalActivity);
  });

  it("shows a loading exercise section while a strength workout is still resolving", async () => {
    const originalActivity = { ...mockActivity };
    Object.assign(mockActivity, { activityType: "strength" });
    mockStrengthExercisesUseQuery.mockReturnValue({
      data: undefined,
      error: null,
      isError: false,
      isLoading: true,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Exercises")).toBeDefined();
    Object.assign(mockActivity, originalActivity);
  });

  it("keeps cached strength exercises visible while reporting a refresh failure", async () => {
    const originalActivity = { ...mockActivity };
    Object.assign(mockActivity, { activityType: "strength" });
    mockStrengthExercisesUseQuery.mockReturnValue({
      data: [
        {
          activityId: "10000000-0000-4000-8000-000000000001",
          exerciseIndex: 0,
          exerciseName: "Pull-up",
          equipment: null,
          muscleGroups: null,
          exerciseType: "strength",
          sets: [],
        },
      ],
      error: new Error("Strength exercise refresh failed."),
      isError: true,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Pull-up")).toBeDefined();
    expect(screen.getByText("Strength exercise refresh failed.")).toBeDefined();
    Object.assign(mockActivity, originalActivity);
  });

  it("keeps cached heart-rate zones visible while reporting their refresh failure", async () => {
    mockHrZonesUseQuery.mockReturnValue({
      data: [{ zone: 1, label: "Zone 1", minPct: 0, maxPct: 60, seconds: 300, percent: 100 }],
      error: new Error("Heart-rate zones refresh failed."),
      isError: true,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Heart Rate Zones")).toBeDefined();
    expect(screen.getByText("Heart-rate zones refresh failed.")).toBeDefined();
  });

  it("shows a heart-rate zone error when no cached zone data is available", async () => {
    mockHrZonesUseQuery.mockReturnValue({
      data: undefined,
      error: new Error("Heart-rate zones are unavailable."),
      isError: true,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Heart Rate Zones")).toBeDefined();
    expect(screen.getByText("Heart-rate zones are unavailable.")).toBeDefined();
  });

  it("clears the route hover marker for an intermittent GPS sample", async () => {
    mockStreamUseQuery.mockReturnValue({
      data: mockStreamPoints.map((point, index) =>
        index === 1 ? { ...point, lat: null, lng: null, speed: null } : point,
      ),
      error: null,
      isError: false,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    await waitFor(() => expect(leafletMocks.map).toHaveBeenCalledOnce());
    const metricEvents = capturedEvents.find((events) => events.updateAxisPointer != null);
    if (!metricEvents?.updateAxisPointer) {
      throw new Error("Metrics chart pointer events were not registered");
    }

    metricEvents.updateAxisPointer({
      axesInfo: [{ value: Date.parse(mockStreamPoints[1]?.recordedAt ?? "") }],
    });

    expect(leafletMocks.circleMarker).toHaveBeenCalledTimes(2);
  });

  it("shows a climbing-entry query failure for a climbing activity", async () => {
    mockActivityByIdUseQuery.mockReturnValue({
      data: { ...mockActivity, activityType: "climbing", name: "Morning Climb" },
      error: null,
      isError: false,
      isLoading: false,
    });
    mockClimbingEntriesUseQuery.mockReturnValue({
      data: undefined,
      error: new Error("Climbing entries are unavailable."),
      isError: true,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Climbs")).toBeDefined();
    expect(screen.getByText("Climbing entries are unavailable.")).toBeDefined();
  });

  it("shows a power zone section error", async () => {
    const originalActivity = { ...mockActivity };
    const originalStream = [...mockStreamPoints];
    Object.assign(mockActivity, { activityType: "cycling", avgPower: 220, maxPower: 360 });
    mockStreamPoints.splice(
      0,
      mockStreamPoints.length,
      ...originalStream.map((point) => ({ ...point, power: 210 })),
    );
    mockPowerZonesUseQuery.mockReturnValue({
      data: undefined,
      error: new Error("Power zones are unavailable."),
      isError: true,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Power zones are unavailable.")).toBeDefined();
    Object.assign(mockActivity, originalActivity);
    mockStreamPoints.splice(0, mockStreamPoints.length, ...originalStream);
  });

  it("keeps cached power zones visible while reporting their refresh failure", async () => {
    const originalActivity = { ...mockActivity };
    const originalStream = [...mockStreamPoints];
    Object.assign(mockActivity, { activityType: "cycling", avgPower: 220, maxPower: 360 });
    mockStreamPoints.splice(
      0,
      mockStreamPoints.length,
      ...originalStream.map((point) => ({ ...point, power: 210 })),
    );
    mockPowerZonesUseQuery.mockReturnValue({
      data: {
        ftp: 250,
        zones: [{ zone: 1, label: "Zone 1", minPct: 0, maxPct: 55, seconds: 300, percent: 100 }],
      },
      error: new Error("Power zones refresh failed."),
      isError: true,
      isLoading: false,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.getByText("Power Zones")).toBeDefined();
    expect(screen.getByText("Power zones refresh failed.")).toBeDefined();
    Object.assign(mockActivity, originalActivity);
    mockStreamPoints.splice(0, mockStreamPoints.length, ...originalStream);
  });

  it("does not show a transient power zone section before a nullable result resolves", async () => {
    const originalActivity = { ...mockActivity };
    const originalStream = [...mockStreamPoints];
    Object.assign(mockActivity, { activityType: "cycling", avgPower: 220, maxPower: 360 });
    mockStreamPoints.splice(
      0,
      mockStreamPoints.length,
      ...originalStream.map((point) => ({ ...point, power: 210 })),
    );
    mockPowerZonesUseQuery.mockReturnValue({
      data: undefined,
      error: null,
      isError: false,
      isLoading: true,
    });
    const ActivityDetailPage = await importPage();

    renderWithUnits(<ActivityDetailPage />);

    expect(screen.queryByText("Power Zones")).toBeNull();
    Object.assign(mockActivity, originalActivity);
    mockStreamPoints.splice(0, mockStreamPoints.length, ...originalStream);
  });

  it("recomputes the activity and invalidates detail caches", async () => {
    const ActivityDetailPage = await importPage();
    renderWithUnits(<ActivityDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: "Recompute" }));

    expect(mockRecomputeMutate).toHaveBeenCalledWith({ id: "test-123" });
    await waitFor(() => {
      expect(mockActivityByIdInvalidate).toHaveBeenCalledWith({ id: "test-123" });
    });
    expect(mockActivityStreamInvalidate).toHaveBeenCalledWith({
      id: "test-123",
      maxPoints: 500,
    });
    expect(mockActivityHrZonesInvalidate).toHaveBeenCalledWith({ id: "test-123" });
    expect(mockActivityPowerZonesInvalidate).toHaveBeenCalledWith({ id: "test-123" });
    expect(mockActivityStrengthExercisesInvalidate).toHaveBeenCalledWith({ id: "test-123" });
    expect(mockActivityListInvalidate).toHaveBeenCalled();
    expect(mockCalendarWeekListInvalidate).toHaveBeenCalled();
    expect(mockCalendarActivityOverviewInvalidate).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Recompute" }).disabled).toBe(
        false,
      );
    });
  });

  it("reports recompute failures and shows the server error", async () => {
    const ActivityDetailPage = await importPage();
    renderWithUnits(<ActivityDetailPage />);
    mockRecomputeShouldFail.mockReturnValue(true);

    fireEvent.click(screen.getByRole("button", { name: "Recompute" }));

    await waitFor(() => {
      expect(screen.getByText("Network unavailable")).toBeDefined();
    });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Recompute" }).disabled).toBe(
      false,
    );
  });

  it("keeps previous stream and zone data visible while refetching", async () => {
    const ActivityDetailPage = await importPage();
    renderWithUnits(<ActivityDetailPage />);

    const previousStream = [{ recordedAt: "2026-03-18T07:00:00Z" }];
    const previousZones = [{ zone: 1, seconds: 120 }];

    expect(getPlaceholderData(mockStreamUseQuery.mock.calls[0]?.[1])?.(previousStream)).toBe(
      previousStream,
    );
    expect(getPlaceholderData(mockHrZonesUseQuery.mock.calls[0]?.[1])?.(previousZones)).toBe(
      previousZones,
    );
  });

  describe("provider tombstone status", () => {
    afterEach(() => {
      mockActivity.providerAbsentAt = null;
      mockActivity.providerId = "whoop";
      mockActivity.subsource = null;
    });

    it("shows tombstone status, provider, and removed time on the detail page", async () => {
      mockActivity.providerAbsentAt = "2026-03-05T14:30:00.000Z";
      mockActivity.providerId = "strava";
      mockActivity.subsource = null;

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(screen.getByText("Removed from provider sync")).toBeDefined();
      expect(screen.getByText("Removed")).toBeDefined();
      expect(screen.getByText("Strava")).toBeDefined();
      expect(screen.getByText(formatDateTime("2026-03-05T14:30:00.000Z"))).toBeDefined();
    });
  });

  describe("ActivityHeader unit display", () => {
    it("formats multi-hour activity durations", async () => {
      const ActivityHeader = await importActivityHeader();
      renderWithUnits(
        <ActivityHeader
          activity={{
            ...mockActivity,
            startedAt: "2026-03-18T07:00:00Z",
            endedAt: "2026-03-18T09:05:00Z",
          }}
          units={new UnitConverter("metric")}
        />,
      );

      expect(screen.getByText("2h 5m")).toBeDefined();
    });

    it("shows metric distance and elevation", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />, "metric");
      expect(screen.getByText(/10\.0 km/)).toBeDefined();
      expect(screen.getByText(/200 m/)).toBeDefined();
    });

    it("shows imperial distance and elevation", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />, "imperial");
      expect(screen.getByText(/6\.2 mi/)).toBeDefined();
      expect(screen.getByText(/656 ft/)).toBeDefined();
    });

    it("shows metric speed", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />, "metric");
      expect(screen.getByText(/10\.8 km\/h/)).toBeDefined();
    });

    it("shows imperial speed", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />, "imperial");
      expect(screen.getByText(/6\.7 mph/)).toBeDefined();
    });
  });

  describe("source tree", () => {
    it("opens the queried device facts from the activity's Sources control", async () => {
      mockActivityByIdUseQuery.mockReturnValue({
        data: { ...mockActivity, sourceTree: detailSourceTree },
        error: null,
        isError: false,
        isLoading: false,
      });
      mockHardwareUseQuery.mockReturnValue({
        data: sourceHardware,
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      });
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);
      expect(screen.queryByText("12345678")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Garmin Edge 530 Sources" }));
      expect(screen.getByText("12345678")).toBeVisible();
      expect(screen.getByText("Whoop")).toBeVisible();
    });

    it("expands the server source tree inside the real detail header with distinct transfer branches", async () => {
      mockActivityByIdUseQuery.mockReturnValue({
        data: { ...mockActivity, sourceTree: detailSourceTree },
        error: null,
        isError: false,
        isLoading: false,
      });
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      const trigger = screen.getByRole("button", { name: "Garmin Edge 530 Sources" });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("Strava")).toBeNull();
      expect(screen.getByRole("heading", { name: "Morning Run" })).toBeVisible();
      expect(screen.getByText(/Wed, Mar 18, 2026 at/)).toBeVisible();
      expect(screen.getByText("45m")).toBeVisible();
      expect(screen.getByText("10.0 km")).toBeVisible();

      trigger.focus();
      fireEvent.click(trigger);

      expect(trigger).toHaveAttribute("aria-expanded", "true");
      const details = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
      expect(details).toBeVisible();
      expect(screen.getAllByText("Garmin Edge 530")).toHaveLength(1);
      expect(
        screen.getByRole("link", { name: "View activity for Garmin Edge 530" }),
      ).toHaveAttribute("href", "https://connect.garmin.com/modern/activity/123");
      const strava = screen.getByRole("link", { name: "Strava" }).closest("li");
      if (!strava) throw new Error("Missing Strava branch");
      expect(within(strava).getByText("Apple Health")).toBeVisible();
      expect(within(strava).getByText("Imported from Strava")).toBeVisible();
      expect(screen.getAllByText("Apple Health")).toHaveLength(2);
      expect(screen.getAllByText("Imported from Garmin Connect")).toHaveLength(2);
      expect(
        within(screen.getByRole("region", { name: "Additional sources" })).getByText("WHOOP"),
      ).toBeVisible();
      expect(screen.getByRole("heading", { name: "Morning Run" })).toBeVisible();
      expect(screen.getByText("10.0 km")).toBeVisible();

      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(trigger).toHaveFocus();
      expect(screen.queryByText("Strava")).toBeNull();
    });

    it("renders recording attribution from the server even without flat source links", async () => {
      const ActivityHeader = await importActivityHeader();
      renderWithUnits(
        <ActivityHeader
          activity={{ ...mockActivity, sourceTree: strongSourceTree }}
          units={new UnitConverter("metric")}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Strong Sources" }));
      expect(screen.getAllByText("Strong")).toHaveLength(1);
      expect(screen.getByText("Recording app reported by Apple Health")).toBeVisible();
      expect(screen.getByText("Apple Health")).toBeVisible();
      expect(screen.getByText("Recorded by Strong")).toBeVisible();
    });

    it("keeps unresolved source records expandable without inventing a primary root", async () => {
      const ActivityHeader = await importActivityHeader();
      renderWithUnits(
        <ActivityHeader
          activity={{
            ...mockActivity,
            sourceTree: { primary: null, otherSources: detailSourceTree.otherSources },
          }}
          units={new UnitConverter("metric")}
        />,
      );

      const trigger = screen.getByRole("button", { name: "Sources" });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(trigger);
      expect(
        within(screen.getByRole("region", { name: "Additional sources" })).getByText("WHOOP"),
      ).toBeVisible();
      expect(screen.getByRole("heading", { name: "Morning Run" })).toBeVisible();
    });
  });

  describe("ElevationChart unit consistency", () => {
    it.each([
      { unitSystem: "metric", lowerBound: 2300, upperBound: 2600 },
      { unitSystem: "imperial", lowerBound: 7500, upperBound: 8500 },
    ] satisfies Array<{ unitSystem: UnitSystem; lowerBound: number; upperBound: number }>)(
      "fits the elevation axis to the recorded range in $unitSystem units",
      async ({ unitSystem, lowerBound, upperBound }) => {
        for (const [index, point] of mockStreamPoints.entries()) {
          point.altitude = 2400 + index * 50;
        }
        const ActivityDetailPage = await importPage();
        await act(async () => {
          renderWithUnits(<ActivityDetailPage />, unitSystem);
        });

        const option = findOptionByYAxisName("Elevation");
        if (!option) throw new Error("Expected elevation chart");
        const { init } = await import("echarts");
        const canvasContext = vi
          .spyOn(HTMLCanvasElement.prototype, "getContext")
          .mockReturnValue(null);
        const chart = init(null, null, { renderer: "svg", ssr: true, width: 600, height: 200 });
        try {
          chart.setOption(option);
          expect(chart.convertFromPixel({ yAxisIndex: 0 }, 170)).toBeGreaterThan(lowerBound);
          expect(chart.convertFromPixel({ yAxisIndex: 0 }, 10)).toBeLessThan(upperBound);
        } finally {
          chart.dispose();
          canvasContext.mockRestore();
        }
      },
    );

    it("converts both series data and tooltip to the same unit system", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />, "imperial");

      const elevOption = findOptionByYAxisName("Elevation");
      expect(elevOption).toBeDefined();
      if (!elevOption) return;

      const data = getSeriesData(elevOption);
      const firstValue = data[0];
      expect(firstValue).toBe(Math.round(new UnitConverter("imperial").convertElevation(100)));
      expect(getYAxisName(elevOption)).toContain(new UnitConverter("imperial").elevationLabel);
    });

    it("keeps elevation in meters for metric", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />, "metric");

      const elevOption = findOptionByYAxisName("Elevation");
      expect(elevOption).toBeDefined();
      if (!elevOption) return;

      const data = getSeriesData(elevOption);
      expect(data[0]).toBe(100);
      expect(getYAxisName(elevOption)).toContain("m");
    });
  });

  describe("MetricsChart speed unit display", () => {
    it("uses imperial speed label on y-axis", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />, "imperial");

      const speedOption = findOptionByYAxisArrayName("Speed");
      expect(speedOption).toBeDefined();
      if (!speedOption) return;

      const yAxes = speedOption.yAxis;
      if (!Array.isArray(yAxes)) return;
      const speedAxis = yAxes.find(
        (y: Record<string, unknown>) => typeof y.name === "string" && y.name.includes("Speed"),
      );
      expect(speedAxis).toBeDefined();
      expect(String(speedAxis?.name)).toContain(new UnitConverter("imperial").speedLabel);
    });
  });

  describe("MetricsChart timeline zoom", () => {
    it("formats the tooltip timestamp as a readable local date and time", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      const option = findOptionByYAxisArrayName("Heart Rate");
      const tooltip = option?.tooltip;
      expect(tooltip).toBeDefined();
      if (!tooltip || typeof tooltip !== "object") throw new Error("Expected tooltip");
      const axisPointer = Reflect.get(tooltip, "axisPointer");
      const formatter = axisPointer?.label?.formatter;
      expect(typeof formatter).toBe("function");
      if (typeof formatter !== "function") throw new Error("Expected timestamp formatter");

      expect(formatter({ value: Date.parse(mockStreamPoints[0]?.recordedAt ?? "") })).toBe(
        formatDateTime("2026-03-18T07:00:00Z"),
      );
    });

    it("shows a draggable navigator with formatted time labels", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      const metricsOption = findOptionByYAxisArrayName("Heart Rate");
      expect(metricsOption).toBeDefined();
      if (!metricsOption) return;

      const slider = getSliderDataZoom(metricsOption);
      expect(slider).toMatchObject({
        showDataShadow: false,
        showDetail: true,
        height: 32,
        handleSize: "100%",
      });

      const labelFormatter = slider?.labelFormatter;
      expect(typeof labelFormatter).toBe("function");
      if (typeof labelFormatter === "function") {
        expect(labelFormatter(Date.parse(mockStreamPoints[0]?.recordedAt ?? ""))).toBe(
          formatTimeOnly(mockStreamPoints[0]?.recordedAt ?? ""),
        );
      }
    });
  });

  describe("MetricsChart cadence unit display", () => {
    it("labels hiking cadence as steps/min", async () => {
      const originalActivity = { ...mockActivity };
      const originalStream = mockStreamPoints.map((point) => ({ ...point }));

      Object.assign(mockActivity, {
        activityType: "hiking",
        avgCadence: 85,
        avgCadenceState: { status: "available" },
      });
      mockStreamPoints.splice(
        0,
        mockStreamPoints.length,
        ...originalStream.map((point) => ({ ...point, cadence: 85 })),
      );

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(screen.getByText("85 steps/min")).toBeDefined();

      const cadenceOption = findOptionByYAxisArrayName("Cadence");
      expect(cadenceOption).toBeDefined();
      if (!cadenceOption) return;

      const yAxes = cadenceOption.yAxis;
      if (!Array.isArray(yAxes)) return;
      const cadenceAxis = yAxes.find(
        (y: Record<string, unknown>) => typeof y.name === "string" && y.name.includes("Cadence"),
      );
      expect(String(cadenceAxis?.name)).toBe("Cadence (steps/min)");

      Object.assign(mockActivity, originalActivity);
      mockStreamPoints.splice(0, mockStreamPoints.length, ...originalStream);
    });

    it("labels cycling cadence as rpm", async () => {
      const originalActivity = { ...mockActivity };
      const originalStream = mockStreamPoints.map((point) => ({ ...point }));

      Object.assign(mockActivity, {
        activityType: "cycling",
        avgCadence: 90,
        avgCadenceState: { status: "available" },
      });
      mockStreamPoints.splice(
        0,
        mockStreamPoints.length,
        ...originalStream.map((point) => ({ ...point, cadence: 90 })),
      );

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(screen.getByText("90 rpm")).toBeDefined();

      const cadenceOption = findOptionByYAxisArrayName("Cadence");
      expect(cadenceOption).toBeDefined();
      if (!cadenceOption) return;

      const yAxes = cadenceOption.yAxis;
      if (!Array.isArray(yAxes)) return;
      const cadenceAxis = yAxes.find(
        (y: Record<string, unknown>) => typeof y.name === "string" && y.name.includes("Cadence"),
      );
      expect(String(cadenceAxis?.name)).toBe("Cadence (rpm)");

      Object.assign(mockActivity, originalActivity);
      mockStreamPoints.splice(0, mockStreamPoints.length, ...originalStream);
    });
  });

  describe("strength exercise query gating", () => {
    it("renders recorded strength exercise values and the workout muscle map", async () => {
      const originalData = { ...mockActivity };
      Object.assign(mockActivity, { activityType: "strength", name: "Strength session" });
      const exercises: StrengthExerciseDetail[] = [
        {
          activityId: "10000000-0000-4000-8000-000000000001",
          exerciseIndex: 0,
          exerciseName: "Bench Press",
          equipment: "BARBELL",
          muscleGroups: ["chest"],
          exerciseType: "strength",
          sets: [
            {
              setIndex: 0,
              setType: "working",
              weightKg: 80,
              reps: 5,
              durationSeconds: 45,
              rpe: 8,
              notes: null,
            },
            {
              setIndex: 1,
              setType: null,
              weightKg: null,
              reps: null,
              durationSeconds: null,
              rpe: null,
              notes: null,
            },
          ],
        },
      ];
      mockStrengthExercisesUseQuery.mockReturnValue({
        data: exercises,
        error: null,
        isError: false,
        isLoading: false,
      });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      await waitFor(() => expect(screen.getByTestId("muscle-map-anterior")).toBeDefined());
      expect(screen.getByTestId("muscle-map-posterior")).toBeDefined();
      expect(screen.getByText("Bench Press")).toBeDefined();
      expect(screen.getByText("barbell")).toBeDefined();
      expect(screen.getByText("Weight (kg)")).toBeDefined();
      expect(screen.getByText("80.0")).toBeDefined();
      expect(screen.getByText("45s")).toBeDefined();

      Object.assign(mockActivity, originalData);
    });

    it("disables strength exercises query for non-strength activities", async () => {
      const originalData = { ...mockActivity };
      Object.assign(mockActivity, { activityType: "running" });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      const enabled = getQueryEnabledFlag(mockStrengthExercisesUseQuery.mock.calls[0]?.[1]);
      expect(enabled).toBe(false);

      Object.assign(mockActivity, originalData);
    });

    it("does not treat a raw provider type synonym as a canonical strength activity", async () => {
      const originalData = { ...mockActivity };
      Object.assign(mockActivity, { activityType: "strength_training" });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      const enabled = getQueryEnabledFlag(mockStrengthExercisesUseQuery.mock.calls[0]?.[1]);
      expect(enabled).toBe(false);

      Object.assign(mockActivity, originalData);
    });

    it("enables strength exercises query for strength activities", async () => {
      const originalData = { ...mockActivity };
      Object.assign(mockActivity, { activityType: "strength" });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      const enabled = getQueryEnabledFlag(mockStrengthExercisesUseQuery.mock.calls[0]?.[1]);
      expect(enabled).toBe(true);

      Object.assign(mockActivity, originalData);
    });
  });

  describe("Hangboarding detail query gating", () => {
    it("disables Hangboarding details for non-Hangboarding activities", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(getQueryEnabledFlag(mockHangboardDetailsUseQuery.mock.calls[0]?.[1])).toBe(false);
    });

    it("enables Hangboarding details and uses the Hangboarding label", async () => {
      const originalData = { ...mockActivity };
      Object.assign(mockActivity, { activityType: "hangboard", name: "Repeaters" });
      mockHangboardDetailsUseQuery.mockReturnValue({
        data: {
          planName: "7/3 Repeaters",
          boardName: "Tension Board",
          segmentsError: null,
          summary: {
            durationSeconds: 600,
            workIntervalCount: 1,
            totalWorkDurationSeconds: 7,
            totalRestDurationSeconds: 3,
            exercises: [
              {
                label: "Repeaters",
                workIntervalCount: 1,
                workDurationSeconds: 7,
              },
            ],
          },
        },
        error: null,
        isError: false,
        isLoading: false,
      });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(getQueryEnabledFlag(mockHangboardDetailsUseQuery.mock.calls[0]?.[1])).toBe(true);
      expect(screen.getAllByText("Hangboarding").length).toBeGreaterThanOrEqual(2);

      Object.assign(mockActivity, originalData);
    });
  });

  describe("climbing entries", () => {
    it.each(["hiking", "running", "cycling", "strength", "hangboard"])(
      "hides climbs and disables climbing queries for %s even with cached logs",
      async (activityType) => {
        mockActivityByIdUseQuery.mockReturnValue({
          data: { ...mockActivity, activityType },
          error: null,
          isError: false,
          isLoading: false,
        });
        mockClimbingEntriesUseQuery.mockReturnValue({
          data: [climbingLogEntryFixture({ id: "cached-log", title: "Cached climb" })],
          error: null,
          isError: false,
          isLoading: false,
        });
        mockEntrySuggestionsUseQuery.mockReturnValue({
          data: [climbingLogEntryFixture({ id: "suggested-log", title: "Suggested climb" })],
          error: null,
          isLoading: false,
        });

        const ActivityDetailPage = await importPage();
        renderWithUnits(<ActivityDetailPage />);

        expect(screen.queryByRole("heading", { name: "Climbs" })).not.toBeInTheDocument();
        expect(screen.queryByText("Cached climb")).not.toBeInTheDocument();
        expect(screen.queryByText("Suggested climb")).not.toBeInTheDocument();
        expect(getQueryEnabledFlag(mockClimbingEntriesUseQuery.mock.calls[0]?.[1])).toBe(false);
        expect(getQueryEnabledFlag(mockEntrySuggestionsUseQuery.mock.calls[0]?.[1])).toBe(false);
      },
    );

    it("keeps cached climbing records visible when both refreshes fail", async () => {
      Object.assign(mockActivity, { activityType: "climbing" });
      const log = climbingLogEntryFixture({ id: "cached-log", title: "Summit outing" });
      mockClimbingEntriesUseQuery.mockReturnValue({
        data: [log],
        error: new Error("Log refresh failed"),
        isError: true,
        isLoading: false,
      });
      mockEntrySuggestionsUseQuery.mockReturnValue({
        data: [climbingLogEntryFixture({ id: "suggested-log", title: "Ridge traverse" })],
        error: new Error("Suggestions refresh failed"),
        isLoading: false,
      });
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);
      expect(getQueryEnabledFlag(mockClimbingEntriesUseQuery.mock.calls[0]?.[1])).toBe(true);
      expect(mockClimbingEntriesUseQuery).toHaveBeenCalledWith(
        { activityId: "test-123" },
        expect.objectContaining({ enabled: true }),
      );
      expect(screen.getByText("Summit outing")).toBeInTheDocument();
      expect(screen.getByText("Ridge traverse")).toBeInTheDocument();
      expect(screen.getByText("Log refresh failed")).toBeInTheDocument();
      expect(screen.getByText("Suggestions refresh failed")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Attach entry 1, Ridge traverse to this activity" }),
      ).toBeEnabled();
    });
    it("waits for attached climbs before showing the empty suggestions notice", async () => {
      Object.assign(mockActivity, { activityType: "climbing", name: "Morning Rock Climb" });
      mockClimbingEntriesUseQuery.mockReturnValue({
        data: undefined,
        error: null,
        isError: false,
        isLoading: true,
      });
      const ActivityDetailPage = await importPage();
      const view = renderWithUnits(<ActivityDetailPage />);
      const climbsSection = screen.getByRole("heading", { name: "Climbs" }).closest("section");
      if (!climbsSection) throw new Error("Expected a climbs section");
      expect(
        within(climbsSection).queryByText("No unattached climbing logs for this day."),
      ).toBeNull();
      expect(
        within(climbsSection).getByRole("status", { name: "Loading climbs." }),
      ).toBeInTheDocument();

      mockClimbingEntriesUseQuery.mockReturnValue({
        data: [],
        error: null,
        isError: false,
        isLoading: false,
      });
      view.rerender(
        <UnitContext.Provider value={{ unitSystem: "metric", setUnitSystem: () => {} }}>
          <ActivityDetailPage />
        </UnitContext.Provider>,
      );
      expect(
        within(climbsSection).getByText("No unattached climbing logs for this day."),
      ).toBeInTheDocument();
    });

    it("shows one compact loading state while both climbing queries are pending", async () => {
      Object.assign(mockActivity, { activityType: "climbing", name: "Morning Rock Climb" });
      mockClimbingEntriesUseQuery.mockReturnValue({
        data: undefined,
        error: null,
        isError: false,
        isLoading: true,
      });
      mockEntrySuggestionsUseQuery.mockReturnValue({
        data: undefined,
        error: null,
        isLoading: true,
      });
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);
      const climbsSection = screen.getByRole("heading", { name: "Climbs" }).closest("section");
      if (!climbsSection) throw new Error("Expected a climbs section");
      expect(within(climbsSection).getAllByRole("status")).toHaveLength(1);
      expect(within(climbsSection).queryByText("Loading climbing logs...")).toBeNull();
    });

    it("groups attached climbs and suggestions in one section and attaches only the selected entry", async () => {
      Object.assign(mockActivity, { activityType: "climbing", name: "Morning Rock Climb" });
      mockClimbingEntriesUseQuery.mockReturnValue({
        data: [
          climbingLogEntryFixture({
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
                name: "Attached Arete",
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
          }),
        ],
        error: null,
        isError: false,
        isLoading: false,
      });
      mockEntrySuggestionsUseQuery.mockReturnValue({
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
                rockResultLabels: ["sent", "Flash"],
                attemptIndex: 1,
                receivedBeta: true,
                hadCompletedBefore: false,
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
                areaId: "tick-2-area-0",
                areaPath: [
                  {
                    id: "tick-2-area-0",
                    userId: "20000000-0000-4000-8000-000000000002",
                    providerId: "openbeta",
                    externalId: null,
                    name: "Pacific Pipe",
                    parentAreaId: null,
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
                ropeMethod: "lead",
              }),
            ],
          }),
        ],
        error: null,
        isLoading: false,
      });
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);
      expect(getQueryEnabledFlag(mockEntrySuggestionsUseQuery.mock.calls[0]?.[1])).toBe(true);
      const climbsSection = screen.getByRole("heading", { name: "Climbs" }).closest("section");
      if (!climbsSection) throw new Error("Expected a climbs section");
      expect(within(climbsSection).getByText("Attached Arete")).toBeInTheDocument();
      expect(within(climbsSection).getByText("Blue Circuit")).toBeInTheDocument();
      expect(within(climbsSection).getByText("Project")).toBeInTheDocument();
      expect(
        within(climbsSection).getAllByRole("button", {
          name: /^Attach entry [12], (Blue Circuit|Project) to this activity$/,
        }),
      ).toHaveLength(2);
      expect(screen.getByText("Mountain Project")).toBeDefined();
      expect(screen.getByText("OpenBeta")).toBeDefined();
      expect(screen.getByText("Blue Circuit")).toBeDefined();
      expect(screen.getByText("V4", { exact: true })).toBeDefined();
      expect(screen.getAllByText("Flash")).toHaveLength(2);
      const controls = screen.getAllByRole("button", {
        name: /^Attach entry [12], (Blue Circuit|Project) to this activity$/,
      });
      expect(controls).toHaveLength(2);
      const secondControl = controls.at(1);
      if (!secondControl) throw new Error("Expected a second attach control");
      fireEvent.click(secondControl);
      expect(mockAttachEntryMutate).toHaveBeenCalledWith({
        activityId: "test-123",
        climbingLogEntryId: "tick-2",
      });
      await waitFor(() => {
        expect(mockClimbingEntriesInvalidate).toHaveBeenCalledWith({ activityId: "test-123" });
        expect(mockEntrySuggestionsInvalidate).toHaveBeenCalledWith({ activityId: "test-123" });
        expect(mockClimbingSessionSummaryInvalidate).toHaveBeenCalledWith();
        expect(mockClimbingGradeProgressionInvalidate).toHaveBeenCalledWith();
        expect(mockClimbingVolumeByGradeInvalidate).toHaveBeenCalledWith();
      });
      expect(mockActivityByIdInvalidate).not.toHaveBeenCalled();
      expect(mockActivityStreamInvalidate).not.toHaveBeenCalled();
    });

    it.each([
      { state: "loading", error: null, isLoading: true },
      { state: "paused", error: null, isLoading: false },
      {
        state: "unavailable",
        error: new Error("Attached climbs are unavailable. Refresh to try again."),
        isLoading: false,
      },
    ])(
      "keeps suggestions actionable when attached climbs are $state",
      async ({ error, isLoading }) => {
        const originalActivity = { ...mockActivity };
        Object.assign(mockActivity, { activityType: "climbing", name: "Morning Rock Climb" });
        mockClimbingEntriesUseQuery.mockReturnValue({
          data: undefined,
          error,
          isError: error !== null,
          isLoading,
        });
        mockEntrySuggestionsUseQuery.mockReturnValue({
          data: [
            climbingLogEntryFixture({
              id: "available-tick",
              providerId: "openbeta",
              climbId: "available-tick-climb",
              discipline: "rock_climbing",
              sourceName: "OpenBeta",
              sourceLinks: [],
              displayGrade: "5.10a",
              board: null,
              wallAngle: null,
              holdType: null,
              recordedClimbAttemptCount: 1,
              recordedClimbOutcome: "completed",
              climb: {
                ...climbingClimbFixture("openbeta"),
                ...{
                  id: "available-tick-climb",
                  name: "Available Arete",
                  kind: "route",
                  areaId: "available-tick-area-0",
                  areaPath: [
                    {
                      id: "available-tick-area-0",
                      userId: "20000000-0000-4000-8000-000000000002",
                      providerId: "openbeta",
                      externalId: null,
                      name: "Test Crag",
                      parentAreaId: null,
                      coordinates: null,
                    },
                  ],
                  publishedGrades: [{ value: "5.10a", system: "yds" }],
                },
              },
              attempts: [
                climbingAttemptFixture("available-tick", {
                  id: "available-tick-attempt-0",
                  outcome: "completed",
                  ropeMethod: "lead",
                  usedAid: false,
                  fellOrHung: false,
                  rockResultLabels: ["sent", "Onsight"],
                  attemptIndex: 1,
                  receivedBeta: false,
                  hadCompletedBefore: false,
                }),
              ],
            }),
          ],
          error: null,
          isLoading: false,
        });

        const ActivityDetailPage = await importPage();
        renderWithUnits(<ActivityDetailPage />);
        const climbsSection = screen.getByRole("heading", { name: "Climbs" }).closest("section");
        if (!climbsSection) throw new Error("Expected a climbs section");
        expect(within(climbsSection).getByText("Available Arete")).toBeInTheDocument();
        if (error) expect(within(climbsSection).getByText(error.message)).toBeInTheDocument();
        const attachButton = within(climbsSection).getByRole("button", {
          name: "Attach entry 1, Available Arete to this activity",
        });
        expect(attachButton).toBeEnabled();
        fireEvent.click(attachButton);
        expect(mockAttachEntryMutate).toHaveBeenCalledWith({
          activityId: "test-123",
          climbingLogEntryId: "available-tick",
        });
        await waitFor(() =>
          expect(mockClimbingEntriesInvalidate).toHaveBeenCalledWith({ activityId: "test-123" }),
        );
        Object.assign(mockActivity, originalActivity);
      },
    );

    it("shows the server error when attaching a climbing entry fails", async () => {
      const originalActivity = { ...mockActivity };
      Object.assign(mockActivity, { activityType: "climbing", name: "Morning Rock Climb" });
      mockAttachShouldFail.mockReturnValue(true);
      mockEntrySuggestionsUseQuery.mockReturnValue({
        data: [
          climbingLogEntryFixture({
            id: "tick-1",
            providerId: "openbeta",
            climbId: "tick-1-climb",
            discipline: "rock_climbing",
            sourceName: "OpenBeta",
            sourceLinks: [],
            displayGrade: "5.10a",
            board: null,
            wallAngle: null,
            holdType: null,
            recordedClimbAttemptCount: 1,
            recordedClimbOutcome: "completed",
            climb: {
              ...climbingClimbFixture("openbeta"),
              ...{
                id: "tick-1-climb",
                name: "The Corner",
                kind: "route",
                areaId: "tick-1-area-0",
                areaPath: [
                  {
                    id: "tick-1-area-0",
                    userId: "20000000-0000-4000-8000-000000000002",
                    providerId: "openbeta",
                    externalId: null,
                    name: "Test Crag",
                    parentAreaId: null,
                    coordinates: null,
                  },
                ],
                publishedGrades: [{ value: "5.10a", system: "yds" }],
              },
            },
            attempts: [
              climbingAttemptFixture("tick-1", {
                id: "tick-1-attempt-0",
                outcome: "completed",
                ropeMethod: "lead",
                usedAid: false,
                fellOrHung: false,
                rockResultLabels: ["sent", "Onsight"],
                attemptIndex: 1,
                receivedBeta: false,
                hadCompletedBefore: false,
              }),
            ],
          }),
        ],
        error: null,
        isLoading: false,
      });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      fireEvent.click(
        screen.getByRole("button", { name: "Attach entry 1, The Corner to this activity" }),
      );

      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "This climbing entry is no longer available.",
        ),
      );
      Object.assign(mockActivity, originalActivity);
    });

    it("shows separate suggestion loading, error, and empty states", async () => {
      Object.assign(mockActivity, { activityType: "climbing" });
      mockEntrySuggestionsUseQuery.mockReturnValue({
        data: undefined,
        error: null,
        isLoading: true,
      });
      const ActivityDetailPage = await importPage();
      const view = renderWithUnits(<ActivityDetailPage />);
      expect(screen.getByText("Loading climbing logs...")).toBeDefined();
      view.unmount();
      mockEntrySuggestionsUseQuery.mockReturnValue({
        data: undefined,
        error: new Error("Tick service unavailable"),
        isLoading: false,
      });
      const ErrorPage = await importPage();
      renderWithUnits(<ErrorPage />);
      expect(screen.getByText("Tick service unavailable")).toBeDefined();
    });

    it("shows an empty suggestion state when the server returns no matching ticks", async () => {
      Object.assign(mockActivity, { activityType: "climbing" });
      mockEntrySuggestionsUseQuery.mockReturnValue({ data: [], error: null, isLoading: false });
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);
      expect(screen.getByText("No unattached climbing logs for this day.")).toBeDefined();
    });

    it("shows the climbs attached to a merged rock-climbing activity", async () => {
      const originalData = { ...mockActivity };
      Object.assign(mockActivity, {
        activityType: "climbing",
        name: "Morning Rock Climb",
      });
      mockClimbingEntriesUseQuery.mockReturnValue({
        data: [
          climbingLogEntryFixture({
            id: "climb-v4",
            providerId: "kaya",
            climbId: "climb-v4-climb",
            discipline: "rock_climbing",
            sourceName: "Kaya",
            sourceLinks: [],
            displayGrade: "V4",
            board: null,
            wallAngle: null,
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
        error: null,
        isError: false,
        isLoading: false,
      });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(getQueryEnabledFlag(mockClimbingEntriesUseQuery.mock.calls[0]?.[1])).toBe(true);
      expect(screen.getByText("Climbs")).toBeDefined();
      expect(screen.getByText("V4")).toBeDefined();
      expect(screen.getByText("Blue Circuit")).toBeDefined();
      expect(screen.getByText("Sent")).toBeDefined();
      expect(screen.getByText("Attempts: 7")).toBeDefined();
      expect(screen.getByText("Project")).toBeDefined();
      expect(screen.getByText("Attempted")).toBeDefined();
      expect(screen.getByText("Wall angle: 35°")).toBeDefined();
      expect(screen.getAllByText("Attempts: 1")).toHaveLength(2);
      expect(screen.getAllByText("Touchstone Pacific Pipe")).toHaveLength(3);
      expect(
        screen.queryByText("No unattached climbing logs for this day."),
      ).not.toBeInTheDocument();

      Object.assign(mockActivity, originalData);
    });
  });

  describe("power zones query gating", () => {
    it("disables power zones query for non-cycling activities", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      const enabled = getQueryEnabledFlag(mockPowerZonesUseQuery.mock.calls[0]?.[1]);
      expect(enabled).toBe(false);
    });

    it("enables power zones query for cycling activities with power data", async () => {
      const originalActivity = { ...mockActivity };
      const originalStream = [...mockStreamPoints];

      Object.assign(mockActivity, { activityType: "cycling", avgPower: 220, maxPower: 360 });
      mockStreamPoints.splice(
        0,
        mockStreamPoints.length,
        ...originalStream.map((point) => ({ ...point, power: 210 })),
      );

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      const enabled = getQueryEnabledFlag(mockPowerZonesUseQuery.mock.calls[0]?.[1]);
      expect(enabled).toBe(true);

      Object.assign(mockActivity, originalActivity);
      mockStreamPoints.splice(0, mockStreamPoints.length, ...originalStream);
    });

    it("labels the heart rate zone axis with zone names", async () => {
      mockHrZonesUseQuery.mockReturnValue({
        data: [
          { zone: 0, label: "Below Zone 1", minPct: 0, maxPct: 50, seconds: 150, percent: 14.3 },
          { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 300, percent: 28.6 },
          { zone: 2, label: "Endurance", minPct: 60, maxPct: 70, seconds: 600, percent: 57.1 },
        ],
        isLoading: false,
        isError: false,
        error: null,
      });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      const heartRateZoneOption = findOptionByYAxisDataLabel("Zone 1");
      if (!heartRateZoneOption) {
        throw new Error("Heart rate zone chart option was not captured");
      }
      expect(getCategoryAxisData(heartRateZoneOption)).toEqual([
        "Below Zone 1",
        "Zone 1",
        "Zone 2",
      ]);
      expect(getYAxisShowOption(heartRateZoneOption)).toBe(true);
      expect(getCategoryAxisLabelOptions(heartRateZoneOption)).toMatchObject({
        align: "right",
        margin: 10,
        show: true,
        interval: 0,
        rich: {
          zone: expect.objectContaining({ fontWeight: 600 }),
          name: expect.objectContaining({ fontSize: 10 }),
        },
      });
      expect(getGridLeftOption(heartRateZoneOption)).toBe(150);
      expect(formatCategoryAxisLabel(heartRateZoneOption, "Zone 1")).toBe(
        "{zone|Zone 1}\n{name|Recovery}",
      );

      mockHrZonesUseQuery.mockReturnValue({
        data: [],
        isLoading: false,
        isError: false,
        error: null,
      });
    });

    it("shows an empty state when heart rate zones are unavailable for an activity with heart rate", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(screen.getByText("No heart rate zone data")).toBeDefined();
    });

    it("shows the heart rate zones error instead of the empty state when loading zones fails", async () => {
      mockHrZonesUseQuery.mockReturnValue({
        data: [],
        isLoading: false,
        isError: true,
        error: new Error("Unable to load heart rate zones"),
      });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(screen.getByText("Unable to load heart rate zones")).toBeDefined();
      expect(screen.queryByText("No heart rate zone data")).toBeNull();
    });

    it("does not show heart rate zones for non-heart-rate streams while zones are loading", async () => {
      const originalStream = [...mockStreamPoints];
      mockStreamPoints.splice(
        0,
        mockStreamPoints.length,
        ...originalStream.map((point) => ({ ...point, heartRate: null })),
      );
      mockHrZonesUseQuery.mockReturnValue({
        data: [],
        isLoading: true,
        isError: false,
        error: null,
      });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(screen.queryByText("Heart Rate Zones")).toBeNull();
      expect(screen.queryByText("No heart rate zone data")).toBeNull();

      mockStreamPoints.splice(0, mockStreamPoints.length, ...originalStream);
    });

    it("labels the power zone axis with zone names", async () => {
      const originalActivity = { ...mockActivity };
      const originalStream = [...mockStreamPoints];

      Object.assign(mockActivity, { activityType: "cycling", avgPower: 220, maxPower: 360 });
      mockStreamPoints.splice(
        0,
        mockStreamPoints.length,
        ...originalStream.map((point) => ({ ...point, power: 210 })),
      );
      mockPowerZonesUseQuery.mockReturnValue({
        data: {
          ftp: 250,
          zones: [
            { zone: 1, label: "Recovery", minPct: 0, maxPct: 55, seconds: 300, percent: 33.3 },
            { zone: 2, label: "Endurance", minPct: 56, maxPct: 75, seconds: 600, percent: 66.7 },
          ],
        },
        error: null,
        isError: false,
        isLoading: false,
      });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      const powerZoneOption = findOptionByYAxisDataLabel("Zone 1");
      if (!powerZoneOption) {
        throw new Error("Power zone chart option was not captured");
      }
      expect(getCategoryAxisData(powerZoneOption)).toEqual(["Zone 1", "Zone 2"]);
      expect(formatCategoryAxisLabel(powerZoneOption, "Zone 2")).toBe(
        "{zone|Zone 2}\n{name|Endurance}",
      );

      Object.assign(mockActivity, originalActivity);
      mockStreamPoints.splice(0, mockStreamPoints.length, ...originalStream);
    });
  });

  describe("retained activity details", () => {
    it("keeps recorded strength details visible with a refresh error", async () => {
      const exercises: StrengthExerciseDetail[] = [
        {
          activityId: "10000000-0000-4000-8000-000000000001",
          exerciseIndex: 0,
          exerciseName: "Weighted pull-up",
          equipment: null,
          muscleGroups: ["back"],
          exerciseType: "strength",
          sets: [
            {
              setIndex: 0,
              setType: "working",
              weightKg: 20,
              reps: 6,
              durationSeconds: null,
              rpe: null,
              notes: null,
            },
          ],
        },
      ];
      mockActivityByIdUseQuery.mockReturnValue({
        data: { ...mockActivity, activityType: "strength" },
        error: null,
        isError: false,
        isLoading: false,
      });
      mockStrengthExercisesUseQuery.mockReturnValue({
        data: exercises,
        error: new Error("Strength refresh failed"),
        isError: true,
        isLoading: false,
      });
      const ActivityDetailPage = await importPage();

      renderWithUnits(<ActivityDetailPage />);

      expect(screen.getByText("Weighted pull-up")).toBeTruthy();
      expect(screen.getByText("Strength refresh failed")).toBeTruthy();
    });

    it("keeps cached heart-rate and power zones visible with refresh errors", async () => {
      const cyclingPoints = mockStreamPoints.map((point) => ({ ...point, power: 210 }));
      mockActivityByIdUseQuery.mockReturnValue({
        data: { ...mockActivity, activityType: "cycling", avgPower: 210, maxPower: 260 },
        error: null,
        isError: false,
        isLoading: false,
      });
      mockStreamUseQuery.mockReturnValue({
        data: cyclingPoints,
        error: null,
        isError: false,
        isLoading: false,
      });
      mockHrZonesUseQuery.mockReturnValue({
        data: [{ zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 240, percent: 100 }],
        error: new Error("Heart-rate zones refresh failed"),
        isError: true,
        isLoading: false,
      });
      mockPowerZonesUseQuery.mockReturnValue({
        data: {
          ftp: 250,
          zones: [
            { zone: 1, label: "Endurance", minPct: 56, maxPct: 75, seconds: 240, percent: 100 },
          ],
        },
        error: new Error("Power zones refresh failed"),
        isError: true,
        isLoading: false,
      });
      const ActivityDetailPage = await importPage();

      renderWithUnits(<ActivityDetailPage />);

      expect(screen.getByText("Heart Rate Zones")).toBeTruthy();
      expect(screen.getByText("Power Zones")).toBeTruthy();
      expect(screen.getByText("Heart-rate zones refresh failed")).toBeTruthy();
      expect(screen.getByText("Power zones refresh failed")).toBeTruthy();
    });

    it("does not render sensor sections when every optional sensor is absent", async () => {
      mockStreamUseQuery.mockReturnValue({
        data: [],
        error: null,
        isError: false,
        isLoading: false,
      });
      mockRouteUseQuery.mockReturnValue({
        data: { status: "unavailable" },
        error: null,
        isLoading: false,
      });
      const ActivityDetailPage = await importPage();

      renderWithUnits(<ActivityDetailPage />);

      expect(screen.queryByText("Route Map")).toBeNull();
      expect(screen.queryByText("Performance")).toBeNull();
      expect(screen.queryByText("Elevation Profile")).toBeNull();
      expect(screen.queryByText("Heart Rate Zones")).toBeNull();
    });
  });
});

describe("activity heart-rate sources", () => {
  it("preselects the default source and switches the trace and zones together", async () => {
    mockMetricSourcesUseQuery.mockReturnValue({
      data: [
        {
          key: "heartRate",
          label: "Heart Rate",
          sources: [
            {
              id: "whoop",
              label: "WHOOP",
              presentation: {
                displayName: "WHOOP",
                providerId: "whoop",
                sourceName: null,
                attribution: { kind: "cloud", label: "via WHOOP" },
              },
            },
            {
              id: "garmin",
              label: "Garmin",
              presentation: {
                displayName: "Garmin",
                providerId: "garmin",
                sourceName: null,
                attribution: { kind: "cloud", label: "via Garmin" },
              },
            },
          ],
          defaultSourceId: "whoop",
        },
      ],
      error: null,
      isError: false,
      isLoading: false,
    });
    const { ActivityDetailPage } = await import("./ActivityDetailPage.tsx");
    renderWithUnits(<ActivityDetailPage />);
    const trigger = screen.getByRole("button", { name: "Heart Rate source: WHOOP" });
    fireEvent.click(trigger);
    expect(screen.getByRole("radio", { name: "WHOOP" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Garmin" }));
    expect(screen.getByRole("button", { name: "Heart Rate source: Garmin" })).toBeVisible();
    expect(mockStreamUseQuery).toHaveBeenLastCalledWith(
      { id: "test-123", maxPoints: 500, sources: { heartRate: "garmin" } },
      expect.anything(),
    );
    expect(mockHrZonesUseQuery).toHaveBeenLastCalledWith(
      { id: "test-123", heartRateSourceId: "garmin" },
      expect.anything(),
    );
  });
});

it("keeps the HR source picker available to recover from a failed source switch", async () => {
  mockMetricSourcesUseQuery.mockReturnValue({
    data: [
      {
        key: "heartRate",
        label: "Heart Rate",
        sources: [
          {
            id: "whoop",
            label: "WHOOP",
            presentation: {
              displayName: "WHOOP",
              providerId: "whoop",
              sourceName: null,
              attribution: { kind: "cloud", label: "via WHOOP" },
            },
          },
          {
            id: "garmin",
            label: "Garmin",
            presentation: {
              displayName: "Garmin",
              providerId: "garmin",
              sourceName: null,
              attribution: { kind: "cloud", label: "via Garmin" },
            },
          },
        ],
        defaultSourceId: "whoop",
      },
    ],
    error: null,
    isError: false,
    isLoading: false,
  });
  mockStreamUseQuery.mockImplementation((input: unknown) => {
    if (
      input &&
      typeof input === "object" &&
      "sources" in input &&
      input.sources !== null &&
      typeof input.sources === "object" &&
      "heartRate" in input.sources &&
      input.sources.heartRate === "garmin"
    ) {
      return {
        data: undefined,
        error: new Error("Garmin samples could not be read"),
        isError: true,
        isLoading: false,
      };
    }
    return { data: mockStreamPoints, error: null, isError: false, isLoading: false };
  });
  const { ActivityDetailPage } = await import("./ActivityDetailPage.tsx");
  renderWithUnits(<ActivityDetailPage />);
  fireEvent.click(screen.getByRole("button", { name: /Heart Rate source:/ }));
  fireEvent.click(screen.getByRole("radio", { name: "Garmin" }));
  expect(screen.getByText("Garmin samples could not be read")).toBeInTheDocument();
  expect(screen.queryByText("No samples for the selected sources.")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Heart Rate source:/ }));
  fireEvent.click(screen.getByRole("radio", { name: "WHOOP" }));
  expect(screen.getByRole("button", { name: "Heart Rate source: WHOOP" })).toBeVisible();
});

it("selects independent metric sources and sends elevation and zone choices", async () => {
  mockMetricSourcesUseQuery.mockReturnValue({
    data: [
      {
        key: "heartRate",
        label: "Heart Rate",
        sources: [
          {
            id: "whoop",
            label: "WHOOP",
            presentation: {
              displayName: "WHOOP",
              providerId: "whoop",
              sourceName: null,
              attribution: { kind: "cloud", label: "via WHOOP" },
            },
          },
          {
            id: "garmin",
            label: "Garmin",
            presentation: {
              displayName: "Garmin",
              providerId: "garmin",
              sourceName: null,
              attribution: { kind: "cloud", label: "via Garmin" },
            },
          },
        ],
        defaultSourceId: "whoop",
      },
      {
        key: "power",
        label: "Power",
        sources: [
          {
            id: "wahoo",
            label: "Wahoo",
            presentation: {
              displayName: "Wahoo",
              providerId: "wahoo",
              sourceName: null,
              attribution: { kind: "cloud", label: "via Wahoo" },
            },
          },
          {
            id: "garmin",
            label: "Garmin",
            presentation: {
              displayName: "Garmin",
              providerId: "garmin",
              sourceName: null,
              attribution: { kind: "cloud", label: "via Garmin" },
            },
          },
        ],
        defaultSourceId: "wahoo",
      },
      {
        key: "altitude",
        label: "Elevation",
        sources: [
          {
            id: "wahoo",
            label: "Wahoo",
            presentation: {
              displayName: "Wahoo",
              providerId: "wahoo",
              sourceName: null,
              attribution: { kind: "cloud", label: "via Wahoo" },
            },
          },
          {
            id: "garmin",
            label: "Garmin",
            presentation: {
              displayName: "Garmin",
              providerId: "garmin",
              sourceName: null,
              attribution: { kind: "cloud", label: "via Garmin" },
            },
          },
        ],
        defaultSourceId: "wahoo",
      },
    ],
    error: null,
    isError: false,
    isLoading: false,
  });
  const { ActivityDetailPage } = await import("./ActivityDetailPage.tsx");
  renderWithUnits(<ActivityDetailPage />);
  fireEvent.click(screen.getByRole("button", { name: /Power source:/ }));
  fireEvent.click(screen.getByRole("radio", { name: "Garmin" }));
  fireEvent.click(screen.getByRole("button", { name: /Elevation source:/ }));
  fireEvent.click(screen.getByRole("radio", { name: "Garmin" }));
  expect(screen.getByRole("button", { name: "Heart Rate source: WHOOP" })).toBeVisible();
  expect(mockStreamUseQuery).toHaveBeenLastCalledWith(
    {
      id: "test-123",
      maxPoints: 500,
      sources: { heartRate: "whoop", power: "garmin", altitude: "garmin" },
    },
    expect.anything(),
  );
  expect(mockPowerZonesUseQuery).toHaveBeenLastCalledWith(
    { id: "test-123", powerSourceId: "garmin" },
    expect.anything(),
  );
  expect(mockHrZonesUseQuery).toHaveBeenLastCalledWith(
    { id: "test-123", heartRateSourceId: "whoop" },
    expect.anything(),
  );
});
