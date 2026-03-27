/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";
import type { UnitSystem } from "../lib/units.ts";
import { UnitConverter } from "../lib/units.ts";

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

const mockActivity = {
  name: "Morning Run",
  activityType: "running",
  startedAt: "2026-03-18T07:00:00Z",
  endedAt: "2026-03-18T07:45:00Z",
  totalDistance: 10000,
  calories: 500,
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

const mockStreamPoints = [
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

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    activity: {
      byId: { useQuery: () => ({ data: mockActivity, isLoading: false, error: null }) },
      stream: { useQuery: () => ({ data: mockStreamPoints, isLoading: false }) },
      hrZones: { useQuery: () => ({ data: [], isLoading: false }) },
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

function renderWithUnits(ui: ReactNode, unitSystem: UnitSystem = "metric") {
  capturedOptions.length = 0;
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

async function importPage() {
  const mod = await import("./ActivityDetailPage.tsx");
  return mod.ActivityDetailPage;
}

describe("ActivityDetailPage", () => {
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

    it("renders source links as clickable anchors", async () => {
      const originalData = { ...mockActivity };
      Object.assign(mockActivity, {
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
});
