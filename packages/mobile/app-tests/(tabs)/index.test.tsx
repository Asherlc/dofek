// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRouterPush = vi.fn();
const mockDashboardRefetch = vi.fn(() => Promise.resolve());
const mockAnomalyRefetch = vi.fn(() => Promise.resolve());
const mockDashboardUseQuery = vi.fn();
const mockDashboardV2UseQuery = vi.fn();
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
let mockProviderGuideError: Error | null = null;
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
      dashboardV2: {
        useQuery: (...parameters: unknown[]) => {
          mockDashboardV2UseQuery(...parameters);
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
      dismiss: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
      },
    },
    useUtils: () => ({
      invalidate: mockInvalidate,
      processing: { status: { invalidate: vi.fn() } },
    }),
  },
}));

vi.mock("../../lib/useRefresh", () => ({
  useRefresh: (options: unknown) => mockUseRefresh(options),
}));

vi.mock("../../lib/useProviderGuide", () => ({
  useProviderGuide: () => ({
    showProviderGuide: false,
    dismiss: vi.fn(),
    error: mockProviderGuideError,
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
    mockDashboardV2UseQuery.mockClear();
    mockAnomalyUseQuery.mockClear();
    mockDashboardData = {
      sleep: {
        lastNight: {
          date: "2026-03-20",
          durationMinutes: 480,
          deepPct: 20,
          remPct: 20,
          lightPct: 50,
          awakePct: 10,
          stagingAvailable: true,
        },
      },
      anomalies: { anomalies: [], checkedMetrics: [] },
      latestDate: "2026-03-21",
      summaryDateContext: {
        effectiveDate: "2026-03-21",
        timezone: "America/Los_Angeles",
      },
    };
    mockAnomalyData = undefined;
    mockDataHealthData = undefined;
    mockProviderGuideError = null;
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

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
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

  it("shows provider setup status failures without hiding dashboard data", async () => {
    mockProviderGuideError = new Error("Provider setup status is temporarily unavailable");

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.getByText("Provider setup status is temporarily unavailable")).toBeTruthy();
    expect(screen.getByText("LAST NIGHT")).toBeTruthy();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps cached dashboard data visible while refreshing", async () => {
    mockDashboardLoading = true;
    mockDashboardFetching = true;

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.getByText("LAST NIGHT")).toBeTruthy();
    expect(screen.getByText("8h 0m")).toBeTruthy();
    expect(screen.queryByTestId("query-state-loading")).toBeNull();
  });

  it("shows a non-blocking error when cached dashboard data fails to refresh", async () => {
    mockDashboardError = new Error("Refresh failed");

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.getByText("Refresh failed")).toBeTruthy();
    expect(screen.getByText("LAST NIGHT")).toBeTruthy();
  });

  it("shows last night loading while the dashboard loads after processing is ready", async () => {
    mockDashboardLoading = true;
    mockDashboardFetching = true;
    mockDashboardData = undefined;
    mockDataHealthData = {
      overallStatus: "ready",
      generatedAt: "2026-03-21T08:00:00.000Z",
      scope: { providerId: null, datasets: ["activity", "sleep", "recovery", "training", "body"] },
      operations: [],
      datasets: [],
    };

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.getByText("LAST NIGHT")).toBeTruthy();
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.queryByText("No sleep data")).toBeNull();
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
      stagingAvailable: true,
    };

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.getByText("LAST NIGHT")).toBeTruthy();
  });

  it("renders server-authored dashboard and sleep dates with the effective timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    mockDashboardData = {
      ...mockDashboardData,
      summaryDateContext: {
        effectiveDate: "2026-08-02",
        timezone: "America/Los_Angeles",
      },
      sleep: {
        ...mockDashboardData.sleep,
        lastNight: {
          ...mockDashboardData.sleep.lastNight,
          date: "2026-08-01",
        },
      },
    };

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.getByText("Sun, Aug 2, 2026 · America/Los_Angeles")).toBeTruthy();
    expect(screen.getByText("Night of Sat, Aug 1, 2026 · America/Los_Angeles")).toBeTruthy();
  });

  it("keeps reported duration visible when last night's stages are unavailable", async () => {
    mockDashboardData.sleep.lastNight = {
      date: "2026-03-20",
      durationMinutes: 480,
      deepPct: null,
      remPct: null,
      lightPct: null,
      awakePct: null,
      stagingAvailable: false,
    };

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.getByText("8h 0m recorded. Sleep stages were not reported.")).toBeTruthy();
  });

  it("shows a sleep empty state when the recorded night is missing", async () => {
    mockDashboardData = {
      ...mockDashboardData,
      sleep: { lastNight: null },
    };

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.getByText("LAST NIGHT")).toBeTruthy();
    expect(screen.getAllByText("No sleep data")).toHaveLength(1);
  });

  it("does not enable anomaly detection during the initial dashboard load", async () => {
    mockDashboardLoading = true;
    mockDashboardData = undefined;

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(mockAnomalyUseQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });

  it("enables anomaly detection after dashboard data is available", async () => {
    const { default: TodayScreen } = await import("../../app/(tabs)/index");
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

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.getByText("Resting Heart Rate: 70 (baseline 60 ± 3)")).toBeTruthy();
  });

  it("refreshes dashboard and anomaly queries when pull-to-refresh runs", async () => {
    const { default: TodayScreen } = await import("../../app/(tabs)/index");
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

  it("shows a dashboard error panel when the query fails", async () => {
    mockDashboardError = new Error("Dashboard failed");
    mockDashboardData = undefined;

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.getByText("Dashboard failed")).toBeTruthy();
    expect(mockAnomalyUseQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });
});
