// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRouterPush = vi.fn();
const mockDashboardRefetch = vi.fn(() => Promise.resolve());
const mockAnomalyRefetch = vi.fn(() => Promise.resolve());
const mockDashboardUseQuery = vi.fn();
const mockAnomalyUseQuery = vi.fn();
const mockDataHealthUseQuery = vi.fn();
const mockInvalidate = vi.fn();
const mockUseRefresh = vi.fn((_options: unknown) => ({
  refreshing: false,
  onRefresh: vi.fn(),
}));
let mockDashboardLoading = false;
let mockDashboardFetching = false;
let mockDashboardData: unknown;
let mockDashboardError: Error | null = null;
let mockAnomalyData: unknown;
let mockDataHealthData: unknown;
const mockDataHealthRefetch = vi.fn(() => Promise.resolve());

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("../../lib/trpc", () => ({
  trpc: {
    mobileDashboard: {
      dashboard: {
        useQuery: (...parameters: unknown[]) => {
          mockDashboardUseQuery(...parameters);
          return {
            data: mockDashboardData,
            isLoading: mockDashboardLoading,
            isFetching: mockDashboardFetching,
            isError: !!mockDashboardError,
            error: mockDashboardError,
            refetch: mockDashboardRefetch,
          };
        },
      },
    },
    anomalyDetection: {
      check: {
        useQuery: (...parameters: unknown[]) => {
          mockAnomalyUseQuery(...parameters);
          return {
            data: mockAnomalyData,
            isLoading: false,
            isError: false,
            error: null,
            refetch: mockAnomalyRefetch,
          };
        },
      },
    },
    processing: {
      status: {
        useQuery: (...parameters: unknown[]) => {
          mockDataHealthUseQuery(...parameters);
          return {
            data: mockDataHealthData,
            isLoading: false,
            isError: false,
            error: null,
            refetch: mockDataHealthRefetch,
          };
        },
      },
      triggerSync: {
        useMutation: () => ({
          mutate: vi.fn(),
          mutateAsync: vi.fn(() => Promise.resolve({ jobId: "test-job" })),
        }),
      },
      activeSyncs: { useQuery: () => ({ data: [], isLoading: false }) },
    },
    useUtils: () => ({ invalidate: mockInvalidate }),
  },
}));

vi.mock("../../lib/useAutoSync", () => ({
  useAutoSync: vi.fn(),
}));

vi.mock("../../lib/useRefresh", () => ({
  useRefresh: (options: unknown) => mockUseRefresh(options),
}));

vi.mock("../../lib/useProviderGuide", () => ({
  useProviderGuide: () => ({
    showProviderGuide: false,
    dismiss: vi.fn(),
    isLoading: false,
    providers: [],
  }),
}));

vi.mock("../../lib/units", async () => {
  const { UnitConverter } = await import("@dofek/format/units");
  const actual = await vi.importActual<typeof import("../../lib/units")>("../../lib/units");
  return {
    ...actual,
    useUnitConverter: () => new UnitConverter("metric"),
  };
});

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
  radius: { xl: 16, lg: 12, md: 8, sm: 4, full: 9999 },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  duration: { fast: 150, normal: 300, slow: 500, countUp: 800, chart: 1200, heartbeat: 3000 },
}));

describe("TodayScreen independent loading states", () => {
  beforeEach(() => {
    mockDashboardLoading = false;
    mockDashboardFetching = false;
    mockDashboardRefetch.mockClear();
    mockAnomalyRefetch.mockClear();
    mockDashboardUseQuery.mockClear();
    mockAnomalyUseQuery.mockClear();
    mockDashboardData = {
      readiness: {
        score: 85,
        date: "2026-03-21",
        components: { hrvScore: 80, restingHrScore: 90, sleepScore: 85, respiratoryRateScore: 80 },
        weights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
      },
      sleep: {
        lastNight: {
          date: "2026-03-20",
          durationMinutes: 480,
          deepPct: 20,
          remPct: 20,
          lightPct: 50,
          awakePct: 10,
        },
        sleepDebt: 0,
      },
      strain: {
        dailyStrain: 12,
        acuteLoad: 300,
        chronicLoad: 250,
        workloadRatio: 1.2,
        date: "2026-03-21",
      },
      sleepNeed: {
        baselineMinutes: 480,
        strainDebtMinutes: 20,
        accumulatedDebtMinutes: 10,
        totalNeedMinutes: 510,
        recentNights: [],
        canRecommend: true,
      },
      anomalies: { anomalies: [], checkedMetrics: [] },
      latestDate: "2026-03-21",
    };
    mockAnomalyData = undefined;
    mockDataHealthData = undefined;
    mockDashboardError = null;
    mockRouterPush.mockClear();
    mockDashboardRefetch.mockClear();
    mockInvalidate.mockClear();
    mockDataHealthUseQuery.mockClear();
    mockDataHealthRefetch.mockClear();
    mockUseRefresh.mockClear();
  });

  it("shows data readiness when dashboard summaries are stale", async () => {
    mockDataHealthData = {
      overallStatus: "delayed",
      generatedAt: "2026-06-30T08:00:00.000Z",
      scope: { providerId: null, datasets: ["activity", "sleep", "recovery", "training", "body"] },
      operations: [],
      datasets: [
        {
          key: "dailyMetrics",
          label: "Daily metrics",
          rawRows: 42,
          latestRawAt: "2026-06-30T07:00:00.000Z",
          latestReadModelAt: "2026-06-30T05:00:00.000Z",
          cdcLagSeconds: 7200,
          readModelLagSeconds: 7200,
          status: "stale",
          progressPercentage: null,
          message: "Daily metrics data is synced, but dashboard summaries are still catching up.",
        },
      ],
    };

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(mockDataHealthUseQuery).toHaveBeenCalledWith(
      {
        datasets: ["activity", "sleep", "recovery", "training", "body"],
      },
      expect.any(Object),
    );
    expect(
      screen.getByText("Recomputing daily metrics is taking longer than expected"),
    ).toBeTruthy();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows skeleton placeholder for recovery ring while readiness is loading", async () => {
    mockDashboardLoading = true;
    mockDashboardData = undefined;

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    // In the consolidated query, everything loads together
    expect(screen.getAllByTestId("skeleton-circle").length).toBeGreaterThanOrEqual(1);
  });

  it("keeps cached dashboard data visible while refreshing", async () => {
    mockDashboardLoading = true;
    mockDashboardFetching = true;

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.queryByTestId("skeleton-circle")).toBeNull();
    expect(screen.getByText("LAST NIGHT")).toBeTruthy();
    expect(screen.getByText("RECOVERY BREAKDOWN")).toBeTruthy();
  });

  it("shows a non-blocking error when cached dashboard data fails to refresh", async () => {
    mockDashboardError = new Error("Refresh failed");

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getByText("Refresh failed")).toBeTruthy();
    expect(screen.getByText("LAST NIGHT")).toBeTruthy();
    expect(screen.getByText("RECOVERY BREAKDOWN")).toBeTruthy();
  });

  it("shows skeleton placeholder for strain gauge while workload is loading", async () => {
    mockDashboardLoading = true;
    mockDashboardData = undefined;

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getAllByTestId("skeleton-circle").length).toBeGreaterThanOrEqual(1);
  });

  it("hides sleep summary section while sleep analytics is loading", async () => {
    mockDashboardLoading = true;
    mockDashboardData = undefined;

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.queryByText("LAST NIGHT")).toBeNull();
  });

  it("shows last night summary when sleep data has yesterday's date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));

    mockDashboardData.sleep.lastNight = {
      date: "2026-03-20",
      durationMinutes: 480,
      deepPct: 20,
      remPct: 25,
      lightPct: 45,
      awakePct: 10,
    };

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getByText("LAST NIGHT")).toBeTruthy();
  });

  it("shows sleep no-data states without default numbers when previous night sleep is missing", async () => {
    mockDashboardData = {
      ...mockDashboardData,
      sleep: {
        lastNight: null,
        sleepDebt: 0,
      },
      sleepNeed: null,
    };

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getByText("LAST NIGHT")).toBeTruthy();
    expect(screen.getAllByText("No sleep data")).toHaveLength(2);
  });

  it("renders all rings when no queries are loading", async () => {
    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getAllByText("Recovery").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Strain").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId("skeleton-circle")).toBeNull();
  });

  it("keeps chart tooltip buttons outside dashboard ring navigation buttons", async () => {
    const { default: TodayScreen } = await import("./index");
    const { container } = render(<TodayScreen />);

    expect(container.querySelector("button button")).toBeNull();
  });

  it("does not enable anomaly detection during the initial dashboard load", async () => {
    mockDashboardLoading = true;
    mockDashboardData = undefined;

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(mockAnomalyUseQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });

  it("enables anomaly detection after dashboard data is available", async () => {
    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(mockAnomalyUseQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("shows anomaly alerts from the standalone anomaly query", async () => {
    mockDashboardData = {
      ...mockDashboardData,
      anomalies: null,
    };
    mockAnomalyData = {
      anomalies: [
        {
          date: "2026-03-21",
          metric: "Resting Heart Rate",
          value: 70,
          baselineMean: 60,
          baselineStddev: 3,
          zScore: 3.33,
          severity: "alert",
        },
      ],
      checkedMetrics: ["resting_hr"],
    };

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getByText(/Resting Heart Rate: 70/)).toBeTruthy();
  });

  it("opens add food with today's date and auto-selected meal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 21, 15, 30));

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    fireEvent.click(screen.getByText("Log Food"));

    expect(mockRouterPush).toHaveBeenCalledWith(
      "/food/add?meal=snack&date=2026-03-21&mode=quickadd",
    );
  });

  it("refreshes dashboard and anomaly queries when pull-to-refresh runs", async () => {
    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    const refreshOptions = mockUseRefresh.mock.calls.at(-1)?.[0];
    expect(refreshOptions).toMatchObject({ invalidate: null });
    if (typeof refreshOptions !== "object" || refreshOptions == null) {
      throw new Error("Expected Today refresh options");
    }
    if (!("refresh" in refreshOptions) || typeof refreshOptions.refresh !== "function") {
      throw new Error("Expected Today refresh callback");
    }
    await refreshOptions.refresh();

    expect(mockDashboardRefetch).toHaveBeenCalledOnce();
    expect(mockAnomalyRefetch).toHaveBeenCalledOnce();
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it("shows a recovery error panel when the readiness query fails", async () => {
    mockDashboardError = new Error("Dashboard failed");
    mockDashboardData = undefined;

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getByText("Dashboard failed")).toBeTruthy();
  });

  it("shows a sleep coach error card when the sleep-need query fails", async () => {
    // In consolidated approach, they share the same error state
    mockDashboardError = new Error("Dashboard failed");
    mockDashboardData = undefined;

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getByText("Dashboard failed")).toBeTruthy();
  });
});
