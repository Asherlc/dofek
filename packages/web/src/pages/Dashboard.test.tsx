// @vitest-environment jsdom
import { UnitConverter } from "@dofek/format/units";
import type {
  ReadinessRow,
  SleepPerformanceInfo,
  StrainTargetResult,
  WorkloadRatioResult,
} from "dofek-server/types";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockInsightsQueryResult = {
  data: unknown[] | undefined;
  isLoading: boolean;
  error: Error | null;
};

type MockQueryResult<TData> = {
  data: TData | undefined;
  isLoading: boolean;
  error: Error | null;
};

const mockReadinessQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<ReadinessRow[]>>(() => ({ data: undefined, isLoading: false, error: null })),
);
const mockWorkloadQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<WorkloadRatioResult>>(() => ({
    data: undefined,
    isLoading: false,
    error: null,
  })),
);
const mockStrainTargetQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<StrainTargetResult>>(() => ({
    data: undefined,
    isLoading: false,
    error: null,
  })),
);
const mockSleepPerformanceQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<SleepPerformanceInfo | null>>(() => ({
    data: undefined,
    isLoading: false,
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
  vi.fn<() => MockInsightsQueryResult>(() => ({ data: [], isLoading: false, error: null })),
);
const mockDataHealthQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<unknown>>(() => ({ data: undefined, isLoading: false, error: null })),
);
const mockDashboardEvidenceOverview = vi.hoisted(() => vi.fn());

vi.mock("../components/DailyOverview.tsx", () => ({
  DailyOverview: () => <section aria-label="Daily health summary">Daily overview</section>,
}));

vi.mock("../components/DashboardEvidenceOverview.tsx", () => ({
  DashboardEvidenceOverview: (props: { insightError?: ReactNode }) => {
    mockDashboardEvidenceOverview(props);
    return (
      <section aria-label="Dashboard overview">
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
    dailyMetrics: {
      trends: { useQuery: mockTrendsQuery },
      hrvBaseline: { useQuery: mockHeartRateBaselineQuery },
    },
    insights: {
      compute: { useQuery: mockInsightsQuery },
    },
    sync: {
      dataHealth: { useQuery: mockDataHealthQuery },
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

const coreDashboardQueryData = {
  readiness: [] as ReadinessRow[],
  workloadRatio: {} as WorkloadRatioResult,
  strainTarget: {} as StrainTargetResult,
  sleepPerformance: null as SleepPerformanceInfo | null,
};

describe("Dashboard", () => {
  beforeEach(() => {
    mockReadinessQuery.mockReturnValue({
      data: coreDashboardQueryData.readiness,
      isLoading: false,
      error: null,
    });
    mockWorkloadQuery.mockReturnValue({
      data: coreDashboardQueryData.workloadRatio,
      isLoading: false,
      error: null,
    });
    mockStrainTargetQuery.mockReturnValue({
      data: coreDashboardQueryData.strainTarget,
      isLoading: false,
      error: null,
    });
    mockSleepPerformanceQuery.mockReturnValue({
      data: coreDashboardQueryData.sleepPerformance,
      isLoading: false,
      error: null,
    });
    mockTrendsQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
    mockHeartRateBaselineQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
    mockInsightsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    mockDataHealthQuery.mockReturnValue({ data: undefined, isLoading: false, error: null });
    mockDashboardEvidenceOverview.mockClear();
  });

  it("shows data readiness when dashboard summaries are stale", () => {
    mockDataHealthQuery.mockReturnValue({
      data: {
        overallStatus: "stale",
        generatedAt: "2026-06-30T08:00:00.000Z",
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
            message: "Daily metrics data is synced, but dashboard summaries are still catching up.",
          },
        ],
      },
      isLoading: false,
      error: null,
    });

    render(<Dashboard />);

    expect(screen.getByText("Dashboard summaries are catching up")).toBeTruthy();
    expect(
      screen.getByText(
        "Daily metrics data is synced, but dashboard summaries are still catching up.",
      ),
    ).toBeTruthy();
  });

  it("does not enable insights during the initial core dashboard load", () => {
    mockReadinessQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    mockWorkloadQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    mockStrainTargetQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });
    mockSleepPerformanceQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });

    render(<Dashboard />);

    expect(mockInsightsQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });

  it("enables insights after core dashboard data is available", () => {
    render(<Dashboard />);

    expect(mockInsightsQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: true }),
    );
  });

  it("uses a loading panel while insights are loading", () => {
    mockInsightsQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });

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

  it("renders the daily summary outside and before the 30 day overview", () => {
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
        avg_active_energy: null,
        avg_skin_temp: null,
        stddev_hrv: 7.5,
        stddev_resting_hr: 3.1,
        stddev_spo2: null,
        stddev_skin_temp: null,
        latest_hrv: 48,
        latest_resting_hr: 55,
        latest_spo2: null,
        latest_steps: null,
        latest_active_energy: null,
        latest_skin_temp: null,
        latest_date: "2026-05-27",
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
});

describe("isCoreDashboardReady", () => {
  it("returns false while any core dashboard query is still unresolved", () => {
    expect(
      isCoreDashboardReady({
        readiness: undefined,
        workloadRatio: coreDashboardQueryData.workloadRatio,
        strainTarget: coreDashboardQueryData.strainTarget,
        sleepPerformance: coreDashboardQueryData.sleepPerformance,
      }),
    ).toBe(false);
  });

  it("returns true once all core dashboard queries have settled", () => {
    expect(
      isCoreDashboardReady({
        readiness: coreDashboardQueryData.readiness,
        workloadRatio: coreDashboardQueryData.workloadRatio,
        strainTarget: coreDashboardQueryData.strainTarget,
        sleepPerformance: coreDashboardQueryData.sleepPerformance,
      }),
    ).toBe(true);
  });

  it("returns true when sleep performance resolves to null", () => {
    expect(
      isCoreDashboardReady({
        readiness: coreDashboardQueryData.readiness,
        workloadRatio: coreDashboardQueryData.workloadRatio,
        strainTarget: coreDashboardQueryData.strainTarget,
        sleepPerformance: null,
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
      active_energy_kcal: null,
    },
    {
      date: "2026-03-19",
      spo2_avg: null,
      skin_temp_c: null,
      hrv: null,
      steps: null,
      active_energy_kcal: null,
    },
    {
      date: "2026-03-20",
      spo2_avg: 98,
      skin_temp_c: 35.0,
      hrv: null,
      steps: null,
      active_energy_kcal: null,
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
  it("returns combined title and dual axes when both SpO2 and skin temp are present", () => {
    const config = spo2TempSectionConfig(true, true, new UnitConverter("imperial"));
    expect(config.title).toBe("SpO2 & Skin Temperature");
    expect(config.subtitle).toContain("oxygen");
    expect(config.subtitle).toContain("skin");
    expect(config.yAxis).toHaveLength(2);
    expect(config.yAxis[0]?.name).toBe("SpO2 (%)");
    expect(config.yAxis[1]?.name).toBe("°F");
  });

  it("returns SpO2-only title and single axis when only SpO2 data exists", () => {
    const config = spo2TempSectionConfig(true, false, new UnitConverter("metric"));
    expect(config.title).toBe("Blood Oxygen (SpO2)");
    expect(config.subtitle).toContain("oxygen");
    expect(config.subtitle).not.toContain("skin");
    expect(config.yAxis).toHaveLength(1);
    expect(config.yAxis[0]?.name).toBe("SpO2 (%)");
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
  it("includes resting heart rate as a lower-is-better health metric", () => {
    const metrics = buildHealthMetrics(
      {
        avg_hrv: 43.8,
        avg_resting_hr: 56.2,
        avg_spo2: null,
        avg_steps: null,
        avg_active_energy: null,
        avg_skin_temp: null,
        stddev_hrv: 7.5,
        stddev_resting_hr: 3.1,
        stddev_spo2: null,
        stddev_skin_temp: null,
        latest_hrv: 48,
        latest_resting_hr: 55,
        latest_spo2: null,
        latest_steps: null,
        latest_active_energy: null,
        latest_skin_temp: null,
        latest_date: "2025-03-15",
      },
      new UnitConverter("metric"),
    );

    expect(metrics).toContainEqual({
      label: "Resting Heart Rate",
      value: 55,
      avg: 56.2,
      stddev: 3.1,
      unit: "bpm",
      lowerBetter: true,
    });
  });
});
