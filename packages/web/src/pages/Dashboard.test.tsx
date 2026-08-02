// @vitest-environment jsdom
import { UnitConverter } from "@dofek/format/units";
import { cleanup, render, screen } from "@testing-library/react";
import type {
  ReadinessRow,
  SleepPerformanceInfo,
  StrainTargetResult,
  WorkloadRatioResult,
} from "dofek-server/types";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockInsightsQueryResult = {
  data: unknown[] | undefined;
  isLoading: boolean;
  isFetched: boolean;
  error: Error | null;
};

type MockQueryResult<TData> = {
  data: TData | undefined;
  isLoading: boolean;
  isFetched?: boolean;
  error: Error | null;
};

const mockReadinessQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<ReadinessRow[]>>(() => ({
    data: undefined,
    isLoading: false,
    isFetched: false,
    error: null,
  })),
);
const mockWorkloadQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<WorkloadRatioResult>>(() => ({
    data: undefined,
    isLoading: false,
    isFetched: false,
    error: null,
  })),
);
const mockStrainTargetQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<StrainTargetResult>>(() => ({
    data: undefined,
    isLoading: false,
    isFetched: false,
    error: null,
  })),
);
const mockSleepPerformanceQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<SleepPerformanceInfo | null>>(() => ({
    data: undefined,
    isLoading: false,
    isFetched: false,
    error: null,
  })),
);
const mockTodayPlanQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<unknown>>(() => ({
    data: undefined,
    isLoading: false,
    isFetched: false,
    error: null,
  })),
);
const mockTrendsQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<unknown>>(() => ({ data: undefined, isLoading: false, error: null })),
);
const mockHeartRateBaselineQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<unknown>>(() => ({ data: undefined, isLoading: false, error: null })),
);
const mockInsightsQuery = vi.hoisted(() =>
  vi.fn<() => MockInsightsQueryResult>(() => ({
    data: [],
    isLoading: false,
    isFetched: true,
    error: null,
  })),
);
const mockDataHealthQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<unknown>>(() => ({ data: undefined, isLoading: false, error: null })),
);
const mockDashboardEvidenceOverview = vi.hoisted(() => vi.fn());
const mockDailyOverview = vi.hoisted(() => vi.fn());

vi.mock("../components/DailyOverview.tsx", () => ({
  DailyOverview: (props: Record<string, unknown>) => {
    mockDailyOverview(props);
    return <section aria-label="Daily health summary">Daily overview</section>;
  },
}));

vi.mock("../components/DashboardEvidenceOverview.tsx", () => ({
  DashboardEvidenceOverview: (props: { healthMonitor?: ReactNode; insightError?: ReactNode }) => {
    mockDashboardEvidenceOverview(props);
    return (
      <section aria-label="Dashboard overview">
        {props.healthMonitor}
        {props.insightError ?? <div>Sleep consistency + Heart Rate Variability</div>}
      </section>
    );
  },
}));

vi.mock("../components/HealthStatusBar.tsx", () => ({
  HealthStatusBar: () => <div>Health status bar</div>,
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../hooks/useAutoSync.ts", () => ({
  useAutoSync: () => {},
}));

vi.mock("../hooks/useTodayQueryDate.ts", () => ({
  useTodayQueryDate: () => "2026-05-27",
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    recovery: {
      readinessScore: { useQuery: mockReadinessQuery },
      workloadRatio: { useQuery: mockWorkloadQuery },
      strainTarget: { useQuery: mockStrainTargetQuery },
    },
    sleepNeed: {
      performance: { useQuery: mockSleepPerformanceQuery },
    },
    todayPlan: {
      get: { useQuery: mockTodayPlanQuery },
    },
    dailyMetrics: {
      trends: { useQuery: mockTrendsQuery },
      hrvBaseline: { useQuery: mockHeartRateBaselineQuery },
    },
    insights: {
      compute: { useQuery: mockInsightsQuery },
    },
    processing: {
      status: { useQuery: mockDataHealthQuery },
    },
  },
}));

vi.mock("../lib/unitContext.ts", () => ({
  useUnitConverter: () => new UnitConverter("metric"),
}));

import {
  buildHealthMetrics,
  buildSkinTempSeries,
  Dashboard,
  healthMonitorSubtitle,
  isCoreDashboardReady,
  spo2TempSectionConfig,
} from "./Dashboard";

afterEach(cleanup);

function createCoreDashboardQueryData(): {
  readiness: ReadinessRow[];
  workloadRatio: WorkloadRatioResult;
  strainTarget: StrainTargetResult;
  sleepPerformance: SleepPerformanceInfo | null;
} {
  return {
    readiness: [],
    workloadRatio: {
      context: {
        label: "Recent-to-baseline workload ratio",
        description:
          "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
        recentDays: 7,
        baselineDays: 28,
      },
      displayedStrain: 0,
      displayedDate: "2026-05-27",
      timeSeries: [],
    },
    strainTarget: {
      targetStrain: 12,
      currentStrain: 8,
      progressPercent: 67,
      zone: "Maintain",
      explanation: "Stay in range",
    },
    sleepPerformance: null,
  };
}

const coreDashboardQueryData = createCoreDashboardQueryData();

describe("Dashboard", () => {
  beforeEach(() => {
    mockReadinessQuery.mockReturnValue({
      data: coreDashboardQueryData.readiness,
      isLoading: false,
      isFetched: true,
      error: null,
    });
    mockWorkloadQuery.mockReturnValue({
      data: coreDashboardQueryData.workloadRatio,
      isLoading: false,
      isFetched: true,
      error: null,
    });
    mockStrainTargetQuery.mockReturnValue({
      data: coreDashboardQueryData.strainTarget,
      isLoading: false,
      isFetched: true,
      error: null,
    });
    mockSleepPerformanceQuery.mockReturnValue({
      data: coreDashboardQueryData.sleepPerformance,
      isLoading: false,
      isFetched: true,
      error: null,
    });
    mockTodayPlanQuery.mockReturnValue({
      data: {
        status: "ready",
        date: "2026-05-27",
        action: {
          id: "strain_target",
          title: "No change needs attention — aim for 12 strain",
          summary: "Stay in range",
          zone: "Maintain",
        },
        supportingFacts: [
          { label: "Recovery", value: "60/100" },
          { label: "Strain target", value: "12" },
        ],
        confidence: "moderate",
        freshness: { recoveryDate: "2026-05-27", sleepDate: null },
        missingInputs: ["sleep"],
      },
      isLoading: false,
      isFetched: true,
      error: null,
    });
    mockTrendsQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
    mockHeartRateBaselineQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
    mockInsightsQuery.mockReturnValue({
      data: [],
      isLoading: false,
      isFetched: true,
      error: null,
    });
    mockDataHealthQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
    mockDashboardEvidenceOverview.mockClear();
    mockDailyOverview.mockClear();
  });

  it("uses a 90-day evidence window without widening current-day plan lookups", () => {
    render(<Dashboard />);

    const overviewRange = { days: 90, endDate: "2026-05-27" };
    const planLookback = { days: 30, endDate: "2026-05-27" };
    expect(mockReadinessQuery).toHaveBeenCalledWith(overviewRange);
    expect(mockWorkloadQuery).toHaveBeenCalledWith(overviewRange);
    expect(mockStrainTargetQuery).toHaveBeenCalledWith(planLookback);
    expect(mockTodayPlanQuery).toHaveBeenCalledWith(planLookback);
    expect(mockTrendsQuery).toHaveBeenCalledWith(overviewRange);
    expect(mockHeartRateBaselineQuery).toHaveBeenCalledWith(overviewRange);
    expect(mockInsightsQuery).toHaveBeenCalledWith(
      overviewRange,
      expect.objectContaining({ enabled: true }),
    );
    expect(mockDashboardEvidenceOverview).toHaveBeenCalledWith(
      expect.objectContaining({ days: 90, endDate: "2026-05-27" }),
    );
  });

  it("shows data readiness when dashboard summaries are stale", () => {
    mockDataHealthQuery.mockReturnValue({
      data: {
        overallStatus: "delayed",
        generatedAt: "2026-06-30T08:00:00.000Z",
        scope: {
          providerId: null,
          datasets: ["activity", "sleep", "recovery", "training", "body"],
        },
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
      },
      isLoading: false,
      error: null,
    });

    render(<Dashboard />);

    expect(mockDataHealthQuery).toHaveBeenCalledWith(
      {
        datasets: ["activity", "sleep", "recovery", "training", "body"],
      },
      expect.any(Object),
    );
    expect(
      screen.getByText("Recomputing daily metrics is taking longer than expected", {
        selector: "span",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("progressbar", {
        name: "Recomputing daily metrics is taking longer than expected",
      }),
    ).toBeTruthy();
  });

  it("does not enable insights during the initial core dashboard load", () => {
    mockReadinessQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetched: false,
      error: null,
    });
    mockWorkloadQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetched: false,
      error: null,
    });
    mockStrainTargetQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetched: false,
      error: null,
    });
    mockSleepPerformanceQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetched: false,
      error: null,
    });

    render(<Dashboard />);

    expect(mockInsightsQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
    expect(screen.queryByText("No insights yet.")).toBeNull();
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
  });

  it("enables insights after core dashboard queries settle successfully", () => {
    render(<Dashboard />);

    expect(mockInsightsQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("does not enable insights when a core dashboard prerequisite fails without data", () => {
    mockReadinessQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetched: true,
      error: new Error("Readiness unavailable"),
    });

    render(<Dashboard />);

    expect(mockInsightsQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
    expect(screen.queryByText("No insights yet.")).toBeNull();
    expect(screen.getByText("Insights unavailable until dashboard data loads.")).toBeTruthy();
  });

  it("enables insights when a failed background refresh retains prerequisite data", () => {
    mockReadinessQuery.mockReturnValue({
      data: coreDashboardQueryData.readiness,
      isLoading: false,
      isFetched: true,
      error: new Error("Readiness refresh unavailable"),
    });

    render(<Dashboard />);

    expect(mockInsightsQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("passes every core dashboard query error into the daily summary", () => {
    const readinessError = new Error("Readiness unavailable");
    const workloadError = new Error("Workload unavailable");
    const strainTargetError = new Error("Strain target unavailable");
    const sleepError = new Error("Sleep performance unavailable");
    mockReadinessQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetched: true,
      error: readinessError,
    });
    mockWorkloadQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetched: true,
      error: workloadError,
    });
    mockStrainTargetQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetched: true,
      error: strainTargetError,
    });
    mockSleepPerformanceQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetched: true,
      error: sleepError,
    });

    render(<Dashboard />);

    expect(mockDailyOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        readinessError,
        workloadError,
        strainTargetError,
        sleepError,
      }),
    );
  });

  it("uses a loading panel while insights are loading", () => {
    mockInsightsQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetched: false,
      error: null,
    });

    render(<Dashboard />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.queryByText("Sleep consistency + Heart Rate Variability")).toBeNull();
  });

  it("uses an empty panel when no insights are available", () => {
    render(<Dashboard />);

    expect(screen.getByTestId("query-state-empty")).toBeTruthy();
    expect(screen.getByText("No insights yet.")).toBeTruthy();
    expect(screen.queryByText("Sleep consistency + Heart Rate Variability")).toBeNull();
  });

  it("renders the daily summary outside and before the 90-day overview", () => {
    render(<Dashboard />);

    const dailySummary = screen.getByRole("region", { name: "Daily health summary" });
    const overview = screen.getByRole("region", { name: "Dashboard overview" });

    expect(
      dailySummary.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("passes API-backed resting heart rate chart points into the dashboard overview", () => {
    mockTrendsQuery.mockReturnValue({
      data: {
        avg_hrv: 43.8,
        avg_resting_hr: 56.2,
        avg_spo2: null,
        avg_steps: null,
        avg_skin_temp: null,
        stddev_hrv: 7.5,
        stddev_resting_hr: 3.1,
        stddev_spo2: null,
        stddev_steps: null,
        stddev_skin_temp: null,
        latest_hrv: 48,
        latest_resting_hr: 55,
        latest_spo2: null,
        latest_steps: null,
        latest_skin_temp: null,
        latest_date: "2026-05-27",
        restingHeartRateTrendLabel: "below average",
        baselineRelative: [],
        healthStatus: [],
      },
      isLoading: false,
      error: null,
    });
    mockHeartRateBaselineQuery.mockReturnValue({
      data: [
        { date: "2026-05-25", resting_hr: 57 },
        { date: "2026-05-26", resting_hr: null },
        { date: "2026-05-27", resting_hr: 55 },
      ],
      isLoading: false,
      error: null,
    });

    render(<Dashboard />);

    expect(mockDashboardEvidenceOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        trend: expect.objectContaining({
          latestRestingHeartRate: 55,
          averageRestingHeartRate: 56.2,
          restingHeartRatePoints: [
            { date: "2026-05-25", value: 57 },
            { date: "2026-05-27", value: 55 },
          ],
        }),
        restingHeartRateLoading: false,
        restingHeartRateError: null,
      }),
    );
  });

  it("passes resting heart rate baseline loading and error states into the overview", () => {
    const chartError = new Error("Baseline unavailable.");
    mockHeartRateBaselineQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: chartError,
    });

    render(<Dashboard />);

    expect(mockDashboardEvidenceOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        restingHeartRateLoading: true,
        restingHeartRateError: chartError,
      }),
    );
  });

  it("keeps cached health status visible during a background refresh error", () => {
    mockTrendsQuery.mockReturnValue({
      data: {
        avg_hrv: 43.8,
        avg_resting_hr: 56.2,
        avg_spo2: null,
        avg_steps: null,
        avg_skin_temp: null,
        stddev_hrv: 7.5,
        stddev_resting_hr: 3.1,
        stddev_spo2: null,
        stddev_steps: null,
        stddev_skin_temp: null,
        latest_hrv: 48,
        latest_resting_hr: 55,
        latest_spo2: null,
        latest_steps: null,
        latest_skin_temp: null,
        latest_date: "2026-05-27",
        restingHeartRateTrendLabel: "below average",
        baselineRelative: [],
        healthStatus: [],
      },
      isLoading: false,
      error: new Error("Health status refresh failed."),
    });

    render(<Dashboard />);

    expect(screen.getByText("Health status bar")).toBeTruthy();
    expect(screen.getByText("Health status refresh failed.")).toBeTruthy();
  });
});

describe("isCoreDashboardReady", () => {
  it("returns false while any core dashboard prerequisite is not ready", () => {
    expect(
      isCoreDashboardReady({
        readinessReady: false,
        workloadRatioReady: true,
        strainTargetReady: true,
        sleepPerformanceReady: true,
      }),
    ).toBe(false);
  });

  it("returns true once all core dashboard prerequisites are ready", () => {
    expect(
      isCoreDashboardReady({
        readinessReady: true,
        workloadRatioReady: true,
        strainTargetReady: true,
        sleepPerformanceReady: true,
      }),
    ).toBe(true);
  });
});

describe("buildSkinTempSeries", () => {
  const metrics = [
    {
      date: "2026-03-18",
      spo2_avg: 97,
      skin_temp_c: 34.5,
      hrv: null,
      steps: null,
    },
    {
      date: "2026-03-19",
      spo2_avg: null,
      skin_temp_c: null,
      hrv: null,
      steps: null,
    },
    {
      date: "2026-03-20",
      spo2_avg: 98,
      skin_temp_c: 35.0,
      hrv: null,
      steps: null,
    },
  ];

  it("assigns skin temp series to the second y-axis (yAxisIndex: 1)", () => {
    const series = buildSkinTempSeries(metrics, new UnitConverter("metric"));
    expect(series.yAxisIndex).toBe(1);
  });

  it("converts temperature values using the given unit system", () => {
    const metricSeries = buildSkinTempSeries(metrics, new UnitConverter("metric"));
    const metricValues = metricSeries.data.map(([, v]) => v);
    expect(metricValues).toEqual([34.5, null, 35.0]);

    const imperialSeries = buildSkinTempSeries(metrics, new UnitConverter("imperial"));
    const imperialValues = imperialSeries.data.map(([, v]) => v);
    // 34.5°C = 94.1°F, 35.0°C = 95.0°F
    expect(imperialValues[0]).toBeCloseTo(94.1, 1);
    expect(imperialValues[1]).toBeNull();
    expect(imperialValues[2]).toBeCloseTo(95.0, 1);
  });

  it("uses date strings as the x-axis values", () => {
    const series = buildSkinTempSeries(metrics, new UnitConverter("metric"));
    expect(series.data.map(([date]) => date)).toEqual(["2026-03-18", "2026-03-19", "2026-03-20"]);
  });
});

describe("spo2TempSectionConfig", () => {
  it("returns combined title and dual axes when both blood oxygen and skin temp are present", () => {
    const config = spo2TempSectionConfig(true, true, new UnitConverter("imperial"));
    expect(config.title).toBe("Blood Oxygen Saturation (SpO2) & Skin Temperature");
    expect(config.subtitle).toContain("oxygen");
    expect(config.subtitle).toContain("skin");
    expect(config.yAxis).toHaveLength(2);
    expect(config.yAxis[0]?.name).toBe("Blood Oxygen Saturation (%)");
    expect(config.yAxis[1]?.name).toBe("°F");
  });

  it("returns blood-oxygen-only title and single axis when only blood oxygen data exists", () => {
    const config = spo2TempSectionConfig(true, false, new UnitConverter("metric"));
    expect(config.title).toBe("Blood Oxygen Saturation (SpO2)");
    expect(config.subtitle).toContain("oxygen");
    expect(config.subtitle).not.toContain("skin");
    expect(config.yAxis).toHaveLength(1);
    expect(config.yAxis[0]?.name).toBe("Blood Oxygen Saturation (%)");
  });

  it("returns skin temp-only title and single axis when only skin temp exists", () => {
    const config = spo2TempSectionConfig(false, true, new UnitConverter("metric"));
    expect(config.title).toBe("Skin Temperature");
    expect(config.subtitle).toContain("skin");
    expect(config.subtitle).not.toContain("oxygen");
    expect(config.yAxis).toHaveLength(1);
    expect(config.yAxis[0]?.name).toBe("°C");
  });

  it("uses imperial temperature label when unit system is imperial", () => {
    const config = spo2TempSectionConfig(false, true, new UnitConverter("imperial"));
    expect(config.yAxis[0]?.name).toBe("°F");
  });
});

describe("healthMonitorSubtitle", () => {
  it("returns latest values label", () => {
    expect(healthMonitorSubtitle()).toBe("Latest values vs. rolling average");
  });
});

describe("buildHealthMetrics", () => {
  it("passes through the canonical server health status without recalculating it", () => {
    const restingHeartRateStatus = {
      metric: "resting_heart_rate" as const,
      label: "Resting Heart Rate",
      value: 55,
      valueText: null,
      baseline: 56.2,
      baselineText: null,
      sampleDeviation: 3.1,
      deviation: -0.39,
      direction: "below" as const,
      intent: "lower" as const,
      statusToken: "moving_as_intended" as const,
      statusColor: "positive" as const,
      statusLabel: "Moving as intended",
      evaluationRule: "Below your baseline, where lower values support this metric",
      explanation: "Resting Heart Rate is below your baseline.",
      baselineProgress: {
        requiredObservationDays: 3,
        observedObservationDays: 3,
        hasMeasurableVariation: true,
        blocker: null,
        requirement:
          "A current value plus at least 2 more recorded days with measurable variation.",
        summary: "Resting Heart Rate baseline is ready.",
        action: "No action needed.",
      },
    };
    const metrics = buildHealthMetrics({
      avg_hrv: 43.8,
      avg_resting_hr: 56.2,
      avg_spo2: null,
      avg_steps: null,
      avg_skin_temp: null,
      stddev_hrv: 7.5,
      stddev_resting_hr: 3.1,
      stddev_spo2: null,
      stddev_steps: null,
      stddev_skin_temp: null,
      latest_hrv: 48,
      latest_resting_hr: 55,
      latest_spo2: null,
      latest_steps: null,
      latest_skin_temp: null,
      latest_date: "2025-03-15",
      restingHeartRateTrendLabel: "below average",
      baselineRelative: [],
      healthStatus: [restingHeartRateStatus],
    });

    expect(metrics).toEqual([restingHeartRateStatus]);
  });
});
