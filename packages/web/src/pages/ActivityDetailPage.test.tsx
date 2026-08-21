/** @vitest-environment jsdom */

import { formatDateTime } from "@dofek/format/format";
import type { UnitSystem } from "@dofek/format/units";
import { UnitConverter } from "@dofek/format/units";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityDetail } from "../../../server/src/models/activity.ts";
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
  elevationLoss: null,
  sampleCount: null,
  name: "Morning Run",
  activityType: "running",
  startedAt: "2026-03-18T07:00:00Z",
  endedAt: "2026-03-18T07:45:00Z",
  perceivedExertion: null,
  providerId: "whoop",
  subsource: null,
  providerAbsentAt: null,
  totalDistance: 10000,
  elevationGain: 200,
  avgHr: 150,
  maxHr: 175,
  avgPower: null,
  maxPower: null,
  avgSpeed: 3.0,
  avgCadence: null,
  sourceProviders: ["whoop", "apple_health"],
  sourceLinks: [],
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

const mockStrengthExercisesUseQuery = vi.fn(
  (_input?: unknown, _options?: { enabled?: boolean }) => ({ data: [], isLoading: false }),
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
  data: MockHrZone[];
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
}

function defaultMockHrZonesResult(): MockHrZonesResult {
  return {
    data: [],
    isLoading: false,
    isError: false,
    error: null,
  };
}

const mockHrZonesUseQuery = vi.fn(defaultMockHrZonesResult);
const mockPowerZonesUseQuery = vi.fn(
  (
    _input?: unknown,
    _options?: { enabled?: boolean },
  ): { data: MockPowerZonesResult | null; isLoading: boolean } => ({
    data: null,
    isLoading: false,
  }),
);

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    activity: {
      byId: { useQuery: () => ({ data: mockActivity, isLoading: false, error: null }) },
      stream: { useQuery: () => ({ data: mockStreamPoints, isLoading: false }) },
      hrZones: { useQuery: mockHrZonesUseQuery },
      powerZones: { useQuery: mockPowerZonesUseQuery },
      strengthExercises: { useQuery: mockStrengthExercisesUseQuery },
      delete: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    useUtils: () => ({ activity: { list: { invalidate: vi.fn() } } }),
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
  mockHrZonesUseQuery.mockReset();
  mockHrZonesUseQuery.mockImplementation(defaultMockHrZonesResult);
  mockStreamPoints.splice(
    0,
    mockStreamPoints.length,
    ...initialMockStreamPoints.map((point) => ({ ...point })),
  );
});

function renderWithUnits(ui: ReactNode, unitSystem: UnitSystem = "metric") {
  capturedOptions.length = 0;
  mockStrengthExercisesUseQuery.mockClear();
  mockHrZonesUseQuery.mockClear();
  mockPowerZonesUseQuery.mockClear();
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

function getQueryEnabledFlag(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const enabled = Reflect.get(value, "enabled");
  return typeof enabled === "boolean" ? enabled : undefined;
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
    it("shows session effort only when it was recorded", async () => {
      mockActivity.perceivedExertion = 7;

      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(screen.getByText("Session effort")).toBeDefined();
      expect(screen.getByText("7 / 10")).toBeDefined();

      mockActivity.perceivedExertion = null;
    });

    it("does not show a session effort card when it was not recorded", async () => {
      const ActivityDetailPage = await importPage();
      renderWithUnits(<ActivityDetailPage />);

      expect(screen.queryByText("Session effort")).toBeNull();
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

  describe("MetricsChart cadence unit display", () => {
    it("labels hiking cadence as steps/min", async () => {
      const originalActivity = { ...mockActivity };
      const originalStream = mockStreamPoints.map((point) => ({ ...point }));

      Object.assign(mockActivity, { activityType: "hiking", avgCadence: 85 });
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

      Object.assign(mockActivity, { activityType: "cycling", avgCadence: 90 });
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
        error: { message: "Unable to load heart rate zones" },
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
