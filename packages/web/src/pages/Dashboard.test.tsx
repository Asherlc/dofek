// @vitest-environment jsdom
import { UnitConverter } from "@dofek/format/units";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  refetch?: () => Promise<unknown>;
};

const mockTodayQueryDate = vi.hoisted(() => ({ current: "2026-05-27" }));
const mockStrengthProgressionRefetch = vi.hoisted(() => vi.fn(() => Promise.resolve()));

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
const mockTrainingProgressionStrengthQuery = vi.hoisted(() =>
  vi.fn<() => MockQueryResult<unknown>>(() => ({ data: undefined, isLoading: false, error: null })),
);
const mockDashboardEvidenceOverview = vi.hoisted(() => vi.fn());
const mockHealthStatusBar = vi.hoisted(() => vi.fn());

vi.mock("../components/DashboardEvidenceOverview.tsx", () => ({
  DashboardEvidenceOverview: (props: {
    healthMonitor?: ReactNode;
    insightError?: ReactNode;
    restingHeartRateError?: Error | null;
    hideInsightCard?: boolean;
  }) => {
    mockDashboardEvidenceOverview(props);
    return (
      <section aria-label="Dashboard overview">
        {props.healthMonitor}
        {props.restingHeartRateError ? <div>{props.restingHeartRateError.message}</div> : null}
        {props.hideInsightCard
          ? null
          : (props.insightError ?? <div>Sleep consistency + Heart Rate Variability</div>)}
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
  useTodayQueryDate: () => mockTodayQueryDate.current,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    trainingProgression: { strength: { useQuery: mockTrainingProgressionStrengthQuery } },
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

import {
  repImprovementRow,
  repImprovementWithoutBadge,
} from "../components/training-progression-fixture.ts";
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
    mockTrainingProgressionStrengthQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
      refetch: mockStrengthProgressionRefetch,
    });
    mockStrengthProgressionRefetch.mockClear();
    mockTodayQueryDate.current = "2026-05-27";
    mockDashboardEvidenceOverview.mockClear();
  });

  it("shows one latest eligible strength status with a link that opens Strength", () => {
    mockTrainingProgressionStrengthQuery.mockReturnValue({
      data: [repImprovementWithoutBadge, repImprovementRow],
      isLoading: false,
      error: null,
    });
    render(<Dashboard />);
    const status = screen.getByRole("region", { name: "Training progression status" });
    expect(within(status).getByText("Ready to progress")).toBeTruthy();
    expect(within(status).getByText("Bench press · Barbell")).toBeTruthy();
    expect(within(status).getByRole("link", { name: "Open Strength" })).toBeTruthy();
    expect(within(status).getByText("See recorded sets")).toBeTruthy();
  });

  it("discloses dated strength evidence on Home without leaving the summary", () => {
    mockTrainingProgressionStrengthQuery.mockReturnValue({
      data: [repImprovementRow],
      isLoading: false,
      error: null,
    });
    render(<Dashboard />);
    const status = screen.getByRole("region", { name: "Training progression status" });
    expect(within(status).queryByText(/Nov 20, 2026/)).toBeNull();
    fireEvent.click(within(status).getByText("See recorded sets"));
    expect(within(status).getByText(/Nov 20, 2026 · 10 reps at/)).toBeTruthy();
  });

  it("shows a strength refresh error while keeping the cached status visible", () => {
    mockTrainingProgressionStrengthQuery.mockReturnValue({
      data: [repImprovementRow],
      isLoading: false,
      error: new Error("Could not refresh strength progression"),
    });
    render(<Dashboard />);
    expect(screen.getByText("Could not refresh strength progression")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Training progression status" })).toBeTruthy();
  });

  it("keeps dashboard content usable when no strength status is available", () => {
    mockTrainingProgressionStrengthQuery.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });
    render(<Dashboard />);
    expect(screen.queryByRole("region", { name: "Training progression status" })).toBeNull();
    expect(screen.getByRole("region", { name: "Dashboard overview" })).toBeTruthy();
  });

  it("refetches strength progression when the query date advances without an extra initial fetch", () => {
    mockTrainingProgressionStrengthQuery.mockReturnValue({
      data: [repImprovementRow],
      isLoading: false,
      error: null,
      refetch: mockStrengthProgressionRefetch,
    });
    const { rerender } = render(<Dashboard />);
    expect(mockStrengthProgressionRefetch).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Training progression status" })).toBeTruthy();

    mockTodayQueryDate.current = "2026-05-28";
    rerender(<Dashboard />);

    expect(mockStrengthProgressionRefetch).toHaveBeenCalledOnce();
    expect(screen.getByRole("region", { name: "Training progression status" })).toBeTruthy();
  });

  it("shows one notice when dashboard and processing status queries fail from the same offline condition", () => {
    const message = "We couldn't reach the server. Check your connection and try again.";
    mockTrendsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error(message),
    });
    mockInsightsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetched: true,
      error: new Error(message),
    });
    mockDataHealthQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error(message),
    });

    render(<Dashboard />);

    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.queryByText("Sleep consistency + Heart Rate Variability")).toBeNull();
    expect(mockDashboardEvidenceOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        hideInsightCard: true,
        hideTrendCard: true,
        hideHealthMonitor: true,
      }),
    );
  });

  it("keeps a distinct resting heart rate failure visible when other queries share an offline failure", () => {
    const message = "We couldn't reach the server. Check your connection and try again.";
    const chartError = new Error("Heart rate service unavailable.");
    mockTrendsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error(message),
    });
    mockInsightsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetched: true,
      error: new Error(message),
    });
    mockHeartRateBaselineQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: chartError,
    });
    mockDataHealthQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error(message),
    });

    render(<Dashboard />);

    expect(screen.getByText("Heart rate service unavailable.")).toBeTruthy();
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(mockDashboardEvidenceOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({ hideTrendCard: false, restingHeartRateError: chartError }),
    );
  });

  it("keeps a distinct insight failure visible beside the grouped connection notice", () => {
    const message = "We couldn't reach the server. Check your connection and try again.";
    mockTrendsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error(message),
    });
    mockInsightsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetched: true,
      error: new Error("Insight service unavailable"),
    });
    mockDataHealthQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error(message),
    });

    render(<Dashboard />);

    expect(screen.getByText("Insight service unavailable")).toBeTruthy();
    expect(screen.queryByText("Sleep consistency + Heart Rate Variability")).toBeNull();
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(mockDashboardEvidenceOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({ hideInsightCard: false }),
    );
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

  it("uses a 90-day evidence window and refreshes insights on window focus", () => {
    render(<Dashboard />);

    const overviewRange = { days: 90, endDate: "2026-05-27" };
    expect(mockTrendsQuery).toHaveBeenCalledWith(overviewRange);
    expect(mockHeartRateBaselineQuery).toHaveBeenCalledWith(overviewRange);
    expect(mockInsightsQuery).toHaveBeenCalledWith(
      overviewRange,
      expect.objectContaining({ refetchOnWindowFocus: true }),
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

  it("uses a compact error panel while a cached insight stays visible", () => {
    mockInsightsQuery.mockReturnValue({
      data: [
        {
          id: "cached-insight",
          type: "correlation",
          confidence: "strong",
          metric: "Heart Rate Variability",
          action: "Sleep consistency",
          message: "Cached sleep consistency relationship",
          detail: "90-day correlation",
          whenTrue: { mean: 1, n: 90 },
          whenFalse: { mean: 0, n: 90 },
          effectSize: 0.72,
          pValue: 0.01,
        },
      ],
      isLoading: false,
      isFetched: true,
      error: new Error("Insight service unavailable"),
    });

    render(<Dashboard />);

    expect(screen.getByTestId("query-state-error").style.minHeight).toBe("72px");
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
    expect(
      screen.getByText("No relationships met the evidence threshold for this period."),
    ).toBeTruthy();
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
