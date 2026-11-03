// @vitest-environment jsdom
import { UnitConverter } from "@dofek/format/units";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageLoadProvider } from "../lib/page-load-context.tsx";

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
const mockHealthStatusBar = vi.hoisted(() => vi.fn());

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
  HealthStatusBar: (props: Record<string, unknown>) => {
    mockHealthStatusBar(props);
    return <div>Health status bar</div>;
  },
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../hooks/useTodayQueryDate.ts", () => ({
  useTodayQueryDate: () => "2026-05-27",
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    dailyMetrics: {
      trends: { useQuery: mockTrendsQuery },
      hrvBaseline: { useQuery: mockHeartRateBaselineQuery },
    },
    insights: {
      compute: { useQuery: mockInsightsQuery },
    },
    processing: {
      status: { useQuery: mockDataHealthQuery },
      dismiss: { useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }) },
    },
    useUtils: () => ({ processing: { status: { invalidate: vi.fn() } } }),
  },
}));

vi.mock("../lib/unitContext.ts", () => ({
  useUnitConverter: () => new UnitConverter("metric"),
}));

import { Dashboard } from "./Dashboard";

afterEach(cleanup);

describe("Dashboard", () => {
  it("measures the dashboard when delayed insights settle", () => {
    const measure = vi.fn();
    let frames: FrameRequestCallback[] = [];
    vi.stubGlobal("performance", { now: () => 100, measure });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    mockInsightsQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetched: false,
      error: null,
    });
    const page = (
      <PageLoadProvider route="/dashboard" startedAt={0} sections={["insights"]}>
        <Dashboard />
      </PageLoadProvider>
    );
    const rendered = render(page);
    const paint = () => {
      const pending = frames;
      frames = [];
      act(() =>
        pending.forEach((callback) => {
          callback(100);
        }),
      );
    };
    paint();
    paint();
    expect(measure).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Dashboard overview" })).toBeTruthy();
    mockInsightsQuery.mockReturnValue({ data: [], isLoading: false, isFetched: true, error: null });
    rendered.rerender(
      <PageLoadProvider route="/dashboard" startedAt={0} sections={["insights"]}>
        <Dashboard />
      </PageLoadProvider>,
    );
    paint();
    paint();
    expect(measure).toHaveBeenCalledWith(
      "dofek.page.data-ready",
      expect.objectContaining({
        detail: expect.objectContaining({ route: "/dashboard", outcome: "empty" }),
      }),
    );
    rendered.unmount();
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
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
  });

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
      provenance: null,
      comparison: null,
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
        latest_date: "2025-03-15",
        restingHeartRateTrendLabel: "below average",
        baselineRelative: [],
        healthStatus: [restingHeartRateStatus],
      },
      isLoading: false,
      error: null,
    });
    render(<Dashboard />);

    expect(mockHealthStatusBar).toHaveBeenLastCalledWith(
      expect.objectContaining({ metrics: [restingHeartRateStatus] }),
    );
  });

  it("uses a 90-day evidence window", () => {
    render(<Dashboard />);

    const overviewRange = { days: 90, endDate: "2026-05-27" };
    expect(mockTrendsQuery).toHaveBeenCalledWith(overviewRange);
    expect(mockHeartRateBaselineQuery).toHaveBeenCalledWith(overviewRange);
    expect(mockInsightsQuery).toHaveBeenCalledWith(overviewRange);
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
    expect(screen.getByText("No insights to display.")).toBeTruthy();
    expect(screen.queryByText("Sleep consistency + Heart Rate Variability")).toBeNull();
  });

  it("passes server-smoothed resting heart rate chart points into the dashboard overview", () => {
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
        { date: "2026-05-24", resting_hr: 60, resting_hr_mean_7d: null },
        { date: "2026-05-25", resting_hr: 64, resting_hr_mean_7d: 57.2 },
        { date: "2026-05-26", resting_hr: null, resting_hr_mean_7d: 57.2 },
        { date: "2026-05-27", resting_hr: 55, resting_hr_mean_7d: 56.5 },
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
            { date: "2026-05-25", value: 57.2 },
            { date: "2026-05-27", value: 56.5 },
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
