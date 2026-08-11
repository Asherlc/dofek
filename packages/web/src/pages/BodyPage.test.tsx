// @vitest-environment jsdom

import { UnitConverter } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMocks = vi.hoisted(() => ({
  trends: vi.fn(),
  dailyMetrics: vi.fn(),
  hrvBaseline: vi.fn(),
  stress: vi.fn(),
  weightOverview: vi.fn(),
  insights: vi.fn(),
}));

vi.mock("../components/BodyRecompositionChart.tsx", () => ({
  BodyRecompositionChart: ({ data }: { data: unknown[] }) => (
    <div>Recomposition points: {data.length}</div>
  ),
}));
vi.mock("../components/BodyFatPercentageChart.tsx", () => ({
  BodyFatPercentageChart: ({ data }: { data: unknown[] }) => (
    <div>Body fat points: {data.length}</div>
  ),
}));
vi.mock("../components/CorrelationCard.tsx", () => ({
  CorrelationCard: () => null,
  CorrelationCardSkeleton: () => null,
}));
vi.mock("../components/GoalWeightInput.tsx", () => ({
  GoalWeightInput: () => <div>Goal weight input</div>,
}));
vi.mock("../components/HealthStatusBar.tsx", () => ({
  HealthStatusBar: () => <div>Health status bar</div>,
}));
vi.mock("../components/HrvBaselineChart.tsx", () => ({
  HrvBaselineChart: () => <div>HRV chart</div>,
}));
vi.mock("../components/PageSection.tsx", () => ({
  PageSection: ({ children, title }: { children: ReactNode; title: string }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));
vi.mock("../components/SmoothedWeightChart.tsx", () => ({
  SmoothedWeightChart: ({ data }: { data: unknown[] }) => (
    <div>Smoothed weight points: {data.length}</div>
  ),
}));
vi.mock("../components/StressChart.tsx", () => ({ StressChart: () => <div>Stress chart</div> }));
vi.mock("../components/TimeRangeSelector.tsx", () => ({ TimeRangeSelector: () => null }));
vi.mock("../components/TimeSeriesChart.tsx", () => ({
  TimeSeriesChart: () => <div>Time series chart</div>,
}));
vi.mock("../components/WeightPredictionSummary.tsx", () => ({
  WeightPredictionSummary: () => <div>Weight prediction</div>,
}));
vi.mock("../hooks/useTodayQueryDate.ts", () => ({
  useTodayQueryDate: () => "2026-07-25",
}));
vi.mock("../lib/bodyDaysContext.ts", () => ({
  useBodyDays: () => ({
    days: 30,
    description: "Recommended default: 30 days keeps recent body changes visible.",
    setDays: vi.fn(),
  }),
}));
vi.mock("../lib/unitContext.ts", () => ({
  useUnitConverter: () => new UnitConverter("metric"),
}));
vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    dailyMetrics: {
      trends: { useQuery: queryMocks.trends },
      list: { useQuery: queryMocks.dailyMetrics },
      hrvBaseline: { useQuery: queryMocks.hrvBaseline },
    },
    stress: { scores: { useQuery: queryMocks.stress } },
    bodyAnalytics: { weightOverview: { useQuery: queryMocks.weightOverview } },
    insights: { compute: { useQuery: queryMocks.insights } },
  },
}));

import { BodyPage } from "./BodyPage.tsx";

interface MockQueryOptions {
  data?: unknown;
  error?: Error | null;
  isFetching?: boolean;
}

function mockQuery({ data, error = null, isFetching = false }: MockQueryOptions = {}) {
  return {
    data,
    error,
    isError: error !== null,
    isFetching,
    isLoading: false,
    isPending: false,
    isSuccess: error === null,
    refetch: vi.fn().mockResolvedValue(undefined),
  };
}

const healthyTrends = {
  avg_resting_hr: null,
  latest_resting_hr: null,
  stddev_resting_hr: null,
  healthStatus: [],
};

const healthyWeightOverview = {
  smoothedWeight: [
    {
      date: "2026-07-25",
      rawWeight: 80,
      rawWeightStatus: { kind: "observed", label: "Observed" },
      smoothedWeight: 80,
      smoothedWeightStatus: { kind: "estimated", label: "Estimated" },
      weeklyChange: null,
      interpolated: false,
    },
  ],
  prediction: {
    ratePerWeek: 0,
    rateConfidence: 1,
    impliedDailyCalories: 0,
    periodDeltas: { days7: 0, days14: 0, days30: 0 },
    goal: null,
    projectionLine: [],
  },
  recomposition: [
    {
      date: "2026-07-25",
      weightKg: 80,
      bodyFatPct: 20,
      fatMassKg: 16,
      leanMassKg: 64,
      smoothedFatMass: 16,
      smoothedLeanMass: 64,
    },
  ],
  decisionContext: {
    latestMeasurement: {
      date: "2026-07-25",
      recordedAt: "2026-07-25T15:00:00.000Z",
      recordedAtLocal: "2026-07-25 08:00:00",
      weightKg: 80,
      providerId: "withings",
      sourceName: "Body+",
    },
    trendWeight: {
      smoothing: "ewma",
      alpha: 0.1,
      gapHandling: "linear_interpolation",
      invalidWeightHandling: "exclude_non_positive",
      outlierHandling: "retain",
    },
    variation: {
      status: "insufficient_data",
      observations: 1,
      minimumObservations: 8,
      maximumObservations: 30,
      method: "tukey_inner_fence",
      lowerResidualKg: null,
      upperResidualKg: null,
      outliersIncluded: true,
    },
  },
  healthStatus: [],
};

function setHealthyQueries(): void {
  queryMocks.trends.mockReturnValue(mockQuery({ data: healthyTrends }));
  queryMocks.dailyMetrics.mockReturnValue(mockQuery({ data: [] }));
  queryMocks.hrvBaseline.mockReturnValue(mockQuery({ data: [] }));
  queryMocks.stress.mockReturnValue(mockQuery({ data: undefined }));
  queryMocks.weightOverview.mockReturnValue(mockQuery({ data: healthyWeightOverview }));
  queryMocks.insights.mockReturnValue(mockQuery({ data: [] }));
}

beforeEach(() => {
  vi.clearAllMocks();
  setHealthyQueries();
});

afterEach(cleanup);

describe("BodyPage", () => {
  it("switches the body trend from weight to body fat", () => {
    render(<BodyPage />);

    expect(screen.getByText("Smoothed weight points: 1")).toBeTruthy();
    expect(screen.queryByText("Body fat points: 1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Body Fat" }));

    expect(screen.queryByText("Smoothed weight points: 1")).toBeNull();
    expect(screen.getByText("Body fat points: 1")).toBeTruthy();
  });

  it("shows one dependency notice for a repeated body-composition query failure", () => {
    queryMocks.weightOverview.mockReturnValue(
      mockQuery({ error: new Error("Body measurements are unavailable.") }),
    );

    render(<BodyPage />);

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getAllByText("Body measurements are unavailable.")).toHaveLength(1);
    expect(screen.getByText("Body composition:")).toBeTruthy();
    expect(screen.getByText("Body composition is unavailable. Retry from the notice above.")).toBe(
      screen.getByTestId("query-state-empty").querySelector("p"),
    );
    expect(screen.getByText("Health status bar")).toBeTruthy();
    expect(screen.getByText("Goal weight input")).toBeTruthy();
  });

  it("keeps distinct failed query identities labeled when their messages match", () => {
    const sharedMessage = "Analytics dependency is unavailable.";
    queryMocks.trends.mockReturnValue(mockQuery({ error: new Error(sharedMessage) }));
    queryMocks.hrvBaseline.mockReturnValue(mockQuery({ error: new Error(sharedMessage) }));

    render(<BodyPage />);

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Health overview:")).toBeTruthy();
    expect(screen.getByText("Heart rate variability:")).toBeTruthy();
    expect(screen.getAllByText(sharedMessage)).toHaveLength(2);
  });

  it("retries only failed query identities from the page notice", () => {
    const trends = mockQuery({ error: new Error("Health overview unavailable.") });
    const hrv = mockQuery({ error: new Error("HRV unavailable.") });
    const weight = mockQuery({ data: healthyWeightOverview });
    queryMocks.trends.mockReturnValue(trends);
    queryMocks.hrvBaseline.mockReturnValue(hrv);
    queryMocks.weightOverview.mockReturnValue(weight);

    render(<BodyPage />);
    fireEvent.click(screen.getByRole("button", { name: "Retry unavailable body data" }));

    expect(trends.refetch).toHaveBeenCalledOnce();
    expect(hrv.refetch).toHaveBeenCalledOnce();
    expect(weight.refetch).not.toHaveBeenCalled();
  });

  it("keeps cached body data visible during a background refresh error", () => {
    queryMocks.weightOverview.mockReturnValue(
      mockQuery({
        data: healthyWeightOverview,
        error: new Error("Body data refresh failed."),
        isFetching: true,
      }),
    );

    render(<BodyPage />);

    expect(screen.getByText("Smoothed weight points: 1")).toBeTruthy();
    expect(screen.getByText("Recomposition points: 1")).toBeTruthy();
    expect(screen.getByText("Weight prediction")).toBeTruthy();
    expect(screen.getAllByText("Body data refresh failed.")).toHaveLength(1);
    expect(
      screen.queryByText("Body composition is unavailable. Retry from the notice above."),
    ).toBe(null);
  });
});
