// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRouterPush = vi.fn();
const mockDashboardRefetch = vi.fn(() => Promise.resolve());
const mockTodayPlanRefetch = vi.fn(() => Promise.resolve());
const mockAnomalyRefetch = vi.fn(() => Promise.resolve());
const mockDashboardUseQuery = vi.fn();
const mockDashboardV2UseQuery = vi.fn();
const mockTodayPlanUseQuery = vi.fn();
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
let mockTodayPlanData: unknown;
let mockTodayPlanLoading = false;
let mockTodayPlanError: Error | null = null;
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
    todayPlan: {
      get: {
        useQuery: (...parameters: unknown[]) => {
          mockTodayPlanUseQuery(...parameters);
          return {
            data: mockTodayPlanData,
            isLoading: mockTodayPlanLoading,
            isFetching: false,
            isError: !!mockTodayPlanError,
            error: mockTodayPlanError,
            refetch: mockTodayPlanRefetch,
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
      dismiss: { useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }) },
      triggerSync: {
        useMutation: () => ({
          mutate: vi.fn(),
          mutateAsync: vi.fn(() => Promise.resolve({ jobId: "test-job" })),
        }),
      },
      activeSyncs: { useQuery: () => ({ data: [], isLoading: false }) },
    },
    useUtils: () => ({
      invalidate: mockInvalidate,
      processing: { status: { invalidate: vi.fn() } },
    }),
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
    mockTodayPlanRefetch.mockClear();
    mockAnomalyRefetch.mockClear();
    mockDashboardUseQuery.mockClear();
    mockDashboardV2UseQuery.mockClear();
    mockTodayPlanUseQuery.mockClear();
    mockAnomalyUseQuery.mockClear();
    mockTodayPlanLoading = false;
    mockTodayPlanError = null;
    mockTodayPlanData = {
      status: "ready",
      epistemicStatus: { kind: "suggested", label: "Suggested" },
      date: "2026-03-21",
      action: {
        id: "strain_target",
        title: "No change needs attention — aim for 12 strain",
        summary: "Moderate recovery (60). Aim for a steady training day.",
        zone: "Maintain",
      },
      supportingFacts: [
        { label: "Recovery", value: "85/100" },
        { label: "Sleep performance", value: "88 (Good)" },
      ],
      caveats: [],
      confidence: "high",
      freshness: { recoveryDate: "2026-03-21", sleepDate: "2026-03-20" },
      missingInputs: [],
    };
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
          stagingAvailable: true,
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
        availability: "available",
        epistemicStatus: { kind: "estimated", label: "Estimated" },
        baselineMinutes: 480,
        strainDebtMinutes: 20,
        accumulatedDebtMinutes: 10,
        debtRecoveryMinutes: 17,
        totalNeedMinutes: 517,
        estimateMetadata: {
          basis: "personalized_high_hrv_average",
          baselineQualifyingNightCount: 7,
          debtObservedNightCount: 1,
          methodVersion: "sleep-need-heuristic-v1",
          uncertainty: "not_established",
          valueQualifier: "About",
          summaryLabel: "Heuristic estimate",
          componentLabels: {
            baseline: "Baseline estimate",
            strainDebt: "Previous-day load adjustment",
            debtRecovery: "Debt recovery",
          },
          basisLabel:
            "Baseline uses the average of 7 qualifying nights followed by at-or-above-median heart rate variability.",
          coverageLabel:
            "Sleep-debt input uses 1 observed night from the model's recent-night window.",
          methodLabel: "Method: sleep-need-heuristic-v1",
          uncertaintyLabel: "Uncertainty: not established",
          limitationLabel:
            "This is a descriptive heuristic estimate, not a sleep recommendation. Its uncertainty has not been established.",
        },
        recentNights: [],
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

  it("shows skeleton placeholder for recovery ring while readiness is loading", async () => {
    mockDashboardLoading = true;
    mockDashboardData = undefined;

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    // In the consolidated query, everything loads together
    expect(screen.getAllByTestId("skeleton-circle").length).toBeGreaterThanOrEqual(1);
  });

  it("keeps cached dashboard data visible while refreshing", async () => {
    mockDashboardLoading = true;
    mockDashboardFetching = true;

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.queryByTestId("skeleton-circle")).toBeNull();
    expect(screen.getByText("LAST NIGHT")).toBeTruthy();
    expect(screen.getByText("RECOVERY BREAKDOWN")).toBeTruthy();
  });

  it("shows a non-blocking error when cached dashboard data fails to refresh", async () => {
    mockDashboardError = new Error("Refresh failed");

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.getByText("Refresh failed")).toBeTruthy();
    expect(screen.getByText("LAST NIGHT")).toBeTruthy();
    expect(screen.getByText("RECOVERY BREAKDOWN")).toBeTruthy();
  });

  it("shows skeleton placeholder for strain gauge while workload is loading", async () => {
    mockDashboardLoading = true;
    mockDashboardData = undefined;

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.getAllByTestId("skeleton-circle").length).toBeGreaterThanOrEqual(1);
  });

  it("hides sleep summary section while sleep analytics is loading", async () => {
    mockDashboardLoading = true;
    mockDashboardData = undefined;

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
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

  it("shows one sleep-data prerequisite card when prior sleep is missing", async () => {
    mockDashboardData = {
      ...mockDashboardData,
      sleep: {
        lastNight: null,
        sleepDebt: 0,
      },
      sleepNeed: {
        availability: "missing_previous_night",
        epistemicStatus: { kind: "unavailable", label: "Unavailable" },
        message: "Sync last night's sleep data to see tonight's sleep need.",
      },
    };

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.getByText("SLEEP DATA NEEDED")).toBeTruthy();
    expect(screen.queryByText("LAST NIGHT")).toBeNull();
    expect(screen.queryByText("SLEEP COACH")).toBeNull();
    expect(screen.queryByText("No sleep data")).toBeNull();
    expect(
      screen.getByText("Sync last night's sleep data to see tonight's sleep need."),
    ).toBeTruthy();
    expect(screen.queryByText("Baseline need")).toBeNull();
    expect(screen.queryByText("Strain debt")).toBeNull();
    expect(screen.queryByText("Debt recovery")).toBeNull();
    expect(screen.queryByText("8h 37m")).toBeNull();
  });

  it("keeps a legacy cached sleep prerequisite visible without a status", async () => {
    mockDashboardData = {
      ...mockDashboardData,
      sleep: { lastNight: null, sleepDebt: 0 },
      sleepNeed: {
        availability: "missing_previous_night",
        message: "Sync last night's sleep data to see tonight's sleep need.",
      },
    };

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(
      screen.getByText("Sync last night's sleep data to see tonight's sleep need."),
    ).toBeTruthy();
    expect(screen.queryByText("Unavailable")).toBeNull();
  });

  it("renders the server-authored next action for insufficient sleep need data", async () => {
    mockDashboardData = {
      ...mockDashboardData,
      sleep: {
        lastNight: {
          date: "2026-03-20",
          durationMinutes: 480,
          deepPct: 20,
          remPct: 25,
          lightPct: 45,
          awakePct: 10,
          stagingAvailable: true,
        },
        sleepDebt: 0,
      },
      sleepNeed: {
        availability: "insufficient_data",
        epistemicStatus: { kind: "unavailable", label: "Unavailable" },
        reason: "insufficient_baseline_history",
        message: "Sync at least 7 qualifying nights to estimate sleep need.",
        nextAction: "Sync more sleep and recovery data.",
      },
    };

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(
      screen.getByText("Sync at least 7 qualifying nights to estimate sleep need."),
    ).toBeTruthy();
    expect(screen.getByText("Sync more sleep and recovery data.")).toBeTruthy();
    expect(screen.getByText("LAST NIGHT")).toBeTruthy();
    expect(screen.getByText("SLEEP ESTIMATE")).toBeTruthy();
    expect(screen.queryByText("SLEEP DATA NEEDED")).toBeNull();
  });

  it("renders the V2 sleep value as an uncalibrated heuristic estimate", async () => {
    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(mockDashboardV2UseQuery).toHaveBeenCalled();
    expect(screen.getByText("SLEEP ESTIMATE")).toBeTruthy();
    expect(screen.queryByText("SLEEP COACH")).toBeNull();
    expect(screen.getByText("About 8h 37m")).toBeTruthy();
    expect(screen.getByText("+17m")).toBeTruthy();
    expect(screen.getByText("Heuristic estimate")).toBeTruthy();
    expect(screen.getByText("Previous-day load adjustment")).toBeTruthy();
    expect(
      screen.getByText(
        "Baseline uses the average of 7 qualifying nights followed by at-or-above-median heart rate variability.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Sleep-debt input uses 1 observed night from the model's recent-night window.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Method: sleep-need-heuristic-v1")).toBeTruthy();
    expect(screen.getByText("Uncertainty: not established")).toBeTruthy();
    expect(
      screen.getByText(
        "This is a descriptive heuristic estimate, not a sleep recommendation. Its uncertainty has not been established.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("recommended tonight")).toBeNull();
  });

  it("renders all rings when no queries are loading", async () => {
    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.getAllByText("Recovery").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Strain").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId("skeleton-circle")).toBeNull();
  });

  it("keeps chart tooltip buttons outside dashboard ring navigation buttons", async () => {
    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    const { container } = render(<TodayScreen />);

    expect(container.querySelector("button button")).toBeNull();
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

    expect(screen.getByText(/Resting Heart Rate: 70/)).toBeTruthy();
  });

  it("opens add food with today's date and auto-selected meal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 21, 15, 30));

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    fireEvent.click(screen.getByText("Log Food"));

    expect(mockRouterPush).toHaveBeenCalledWith(
      "/food/add?meal=snack&date=2026-03-21&mode=quickadd",
    );
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

  it("shows a recovery error panel when the readiness query fails", async () => {
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

  it("shows a sleep coach error card when the sleep-need query fails", async () => {
    // In consolidated approach, they share the same error state
    mockDashboardError = new Error("Dashboard failed");
    mockDashboardData = undefined;

    const { default: TodayScreen } = await import("../../app/(tabs)/index");
    render(<TodayScreen />);

    expect(screen.getByText("Dashboard failed")).toBeTruthy();
  });
});
