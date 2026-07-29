/** @vitest-environment jsdom */

import { formatDateTime, formatTimeOnly } from "@dofek/format/format";
import type { UnitSystem } from "@dofek/format/units";
import { UnitConverter } from "@dofek/format/units";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityDetail } from "../../../server/src/models/activity.ts";
import type { ClimbingActivityEntryRow } from "../../../server/src/repositories/climbing-repository.ts";
import { UnitContext } from "../lib/unitContext.ts";

const capturedOptions: Array<Record<string, unknown>> = [];

vi.mock("echarts-for-react", () => ({
  default: (props: { option: Record<string, unknown> }) => {
    capturedOptions.push(props.option);
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

const mockActivity: ActivityDetail = {
  id: "test-123",
  notes: null,
  maxSpeed: null,
  maxSpeedState: { status: "missing", reason: "Max Speed not recorded" },
  elevationLoss: null,
  elevationLossState: { status: "missing", reason: "Elevation Loss not recorded" },
  sampleCount: null,
  sampleCountState: { status: "missing", reason: "Sample Count not recorded" },
  name: "Morning Run",
  activityType: "running",
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
  sourceDecision: null,
};

const mockStreamPoints: Array<{
  recordedAt: string;
  lat: number;
  lng: number;
  heartRate: number | null;
  power: number | null;
  speed: number;
  cadence: number | null;
  altitude: number;
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
const mockClimbingEntriesUseQuery = vi.fn(
  (
    _input?: unknown,
    _options?: { enabled?: boolean },
  ): { data: ClimbingActivityEntryRow[]; isLoading: boolean } => ({
    data: [],
    isLoading: false,
  }),
);

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
const mockPowerZonesUseQuery = vi.fn(
  (_input?: unknown, _options?: { enabled?: boolean }): MockQueryResult<MockPowerZonesResult> => ({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
  }),
);
const mockRecomputeMutate = vi.fn();
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
      byId: { useQuery: mockActivityByIdUseQuery },
      stream: { useQuery: mockStreamUseQuery },
      hrZones: { useQuery: mockHrZonesUseQuery },
      powerZones: { useQuery: mockPowerZonesUseQuery },
      strengthExercises: { useQuery: mockStrengthExercisesUseQuery },
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
      activityEntries: { useQuery: mockClimbingEntriesUseQuery },
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
    }),
  },
}));

vi.mock("leaflet", () => ({
  map: () => ({ remove: vi.fn(), fitBounds: vi.fn() }),
  tileLayer: () => ({ addTo: vi.fn() }),
  latLng: (lat: number, lng: number) => ({ lat, lng }),
  latLngBounds: () => ({}),
  polyline: () => ({ addTo: vi.fn() }),
  circleMarker: () => ({ addTo: vi.fn() }),
}));

afterEach(() => {
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
  mockHrZonesUseQuery.mockReset();
  mockHrZonesUseQuery.mockImplementation(
    (_input?: unknown, _options?: unknown): MockHrZonesResult => defaultMockHrZonesResult(),
  );
  mockClimbingEntriesUseQuery.mockReset();
  mockClimbingEntriesUseQuery.mockReturnValue({ data: [], isLoading: false });
  mockStrengthExercisesUseQuery.mockReset();
  mockStrengthExercisesUseQuery.mockReturnValue({
    data: [],
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
  mockStrengthExercisesUseQuery.mockClear();
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
    return series[0].data;
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

describe("ActivityDetailPage", () => {
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

  it("renders detail metric state and preserves a measured zero", async () => {
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

    expect(screen.getByText("Distance unavailable")).toBeDefined();
    expect(screen.getByText("Distance not recorded")).toBeDefined();
    expect(screen.getByLabelText("Distance unavailable: Distance not recorded")).toBeDefined();

    mockActivityByIdUseQuery.mockReturnValue({
      data: { ...mockActivity, totalDistance: 0, totalDistanceState: { status: "available" } },
      error: null,
      isError: false,
      isLoading: false,
    });
    rerender(<ActivityDetailPage />);

    expect(screen.getByText("0.0 km")).toBeDefined();
    expect(screen.queryByText("Distance unavailable")).toBeNull();
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

  describe("source providers", () => {
    it("shows source providers with human-readable labels", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);
      expect(screen.getByText(/WHOOP/)).toBeDefined();
      expect(screen.getByText(/Apple Health/)).toBeDefined();
    });

    it("shows Apple Health upstream app names when subsource is present", async () => {
      const originalData = { ...mockActivity };
      Object.assign(mockActivity, {
        providerId: "apple_health",
        subsource: "Strong",
        sourceProviders: ["apple_health"],
        sourceLinks: [],
      });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(screen.getByText(/Strong \(via Apple Health\)/)).toBeDefined();

      Object.assign(mockActivity, originalData);
    });

    it("renders multiple Apple Health upstream app source links", async () => {
      const originalData = { ...mockActivity };
      Object.assign(mockActivity, {
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
      });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(screen.getByText(/Strong \(via Apple Health\)/)).toBeDefined();
      expect(screen.getByText(/WHOOP \(via Apple Health\)/)).toBeDefined();
      expect(screen.getByRole("link", { name: "WHOOP (Cloud)" })).toBeDefined();

      Object.assign(mockActivity, originalData);
    });

    it("renders removed source links without anchors", async () => {
      const originalData = { ...mockActivity };
      Object.assign(mockActivity, {
        providerId: "garmin",
        subsource: null,
        sourceProviders: ["garmin", "strava"],
        sourceLinks: [
          {
            providerId: "garmin",
            label: "Garmin",
            url: "https://connect.garmin.com/modern/activity/456",
            providerAbsentAt: null,
          },
          {
            providerId: "strava",
            label: "Strava",
            url: "https://www.strava.com/activities/123",
            providerAbsentAt: "2026-03-05T14:30:00.000Z",
          },
        ],
      });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(screen.getByText("Strava (removed)")).toBeTruthy();
      expect(screen.queryByRole("link", { name: "Strava" })).toBeNull();
      expect(screen.getByRole("link", { name: "Garmin" })).toBeTruthy();

      Object.assign(mockActivity, originalData);
    });

    it("renders source links as clickable anchors", async () => {
      const originalData = { ...mockActivity };
      Object.assign(mockActivity, {
        providerId: "wahoo",
        subsource: null,
        sourceProviders: ["strava", "garmin"],
        sourceLinks: [
          { providerId: "strava", label: "Strava", url: "https://www.strava.com/activities/123" },
          {
            providerId: "garmin",
            label: "Garmin",
            url: "https://connect.garmin.com/modern/activity/456",
          },
        ],
      });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      const stravaLink = screen.getByText("Strava");
      expect(stravaLink.tagName).toBe("A");
      expect(stravaLink.getAttribute("href")).toBe("https://www.strava.com/activities/123");
      expect(stravaLink.getAttribute("target")).toBe("_blank");

      const garminLink = screen.getByText("Garmin");
      expect(garminLink.tagName).toBe("A");
      expect(garminLink.getAttribute("href")).toBe(
        "https://connect.garmin.com/modern/activity/456",
      );

      // Restore
      Object.assign(mockActivity, originalData);
    });

    it("shows how sources were combined when the server returns a source decision", async () => {
      const originalData = { ...mockActivity };
      Object.assign(mockActivity, {
        providerId: "wahoo",
        subsource: null,
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
            url: "https://systm.wahoofitness.com/history/activity-details/42",
            providerAbsentAt: null,
          },
        ],
        sourceDecision: {
          sourceCount: 2,
          primarySourceLabel: "Wahoo",
          explanation:
            "Wahoo was selected as the primary record by source priority. Missing details may come from the other matched sources.",
        },
      });

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(screen.getByRole("heading", { name: "How sources were combined" })).toBeTruthy();
      expect(screen.getByText("2")).toBeTruthy();
      expect(
        screen.getByText(
          "Wahoo was selected as the primary record by source priority. Missing details may come from the other matched sources.",
        ),
      ).toBeTruthy();

      Object.assign(mockActivity, originalData);
    });

    it("hides the source decision card when sourceDecision is null", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(screen.queryByRole("heading", { name: "How sources were combined" })).toBeNull();
    });
  });

  describe("ElevationChart unit consistency", () => {
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
    it("presents the navigator as a labeled control instead of a miniature chart", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(screen.getByText("Zoom timeline")).toBeDefined();
      expect(screen.getByText("Drag the handles to focus on part of the activity.")).toBeDefined();

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
        expect(labelFormatter(0, mockStreamPoints[0]?.recordedAt)).toBe(
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

  describe("climbing entries", () => {
    it("shows the climbs attached to a merged rock-climbing activity", async () => {
      const originalData = { ...mockActivity };
      Object.assign(mockActivity, {
        activityType: "climbing",
        name: "Morning Rock Climb",
      });
      mockClimbingEntriesUseQuery.mockReturnValue({
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

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(getQueryEnabledFlag(mockClimbingEntriesUseQuery.mock.calls[0]?.[1])).toBe(true);
      expect(screen.getByText("Climbs")).toBeDefined();
      expect(screen.getByText("V4")).toBeDefined();
      expect(screen.getByText("Blue Circuit")).toBeDefined();
      expect(screen.getByText("Redpoint")).toBeDefined();
      expect(screen.getByText("Sent in 7 attempts")).toBeDefined();
      expect(screen.getByText("Project")).toBeDefined();
      expect(screen.getByText("Attempted 1 time")).toBeDefined();
      expect(screen.getByText("35° · Crimp")).toBeDefined();
      expect(screen.getByText("1: Technique")).toBeDefined();
      expect(screen.getAllByText("Touchstone Pacific Pipe")).toHaveLength(2);

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
});
