// @vitest-environment jsdom

import { UnitConverter } from "@dofek/format/units";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockWeightOverviewQuery = vi.hoisted(() => vi.fn());

vi.mock("../components/BodyRecompositionChart.tsx", () => ({
  BodyRecompositionChart: ({ data }: { data: unknown[] }) => (
    <div>Recomposition points: {data.length}</div>
  ),
}));
vi.mock("../components/CorrelationCard.tsx", () => ({
  CorrelationCard: () => null,
  CorrelationCardSkeleton: () => null,
}));
vi.mock("../components/GoalWeightInput.tsx", () => ({ GoalWeightInput: () => null }));
vi.mock("../components/HealthStatusBar.tsx", () => ({
  HealthStatusBar: () => <div>Health status bar</div>,
}));
vi.mock("../components/HrvBaselineChart.tsx", () => ({
  HrvBaselineChart: () => <div>HRV chart</div>,
}));
vi.mock("../components/PageSection.tsx", () => ({
  PageSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
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
  useBodyDays: () => ({ days: 30, setDays: vi.fn() }),
}));
vi.mock("../lib/unitContext.ts", () => ({
  useUnitConverter: () => new UnitConverter("metric"),
}));
vi.mock("../lib/trpc.ts", () => {
  const idleQuery = {
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
  };
  return {
    trpc: {
      dailyMetrics: {
        trends: { useQuery: () => idleQuery },
        list: { useQuery: () => idleQuery },
        hrvBaseline: { useQuery: () => idleQuery },
      },
      stress: { scores: { useQuery: () => idleQuery } },
      bodyAnalytics: { weightOverview: { useQuery: mockWeightOverviewQuery } },
      insights: { compute: { useQuery: () => ({ ...idleQuery, data: [] }) } },
    },
  };
});

import { BodyPage } from "./BodyPage.tsx";

afterEach(cleanup);

describe("BodyPage", () => {
  it("keeps cached body data visible during a background refresh error", () => {
    mockWeightOverviewQuery.mockReturnValue({
      data: {
        smoothedWeight: [
          {
            date: "2026-07-25",
            rawWeight: 80,
            smoothedWeight: 80,
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
        healthStatus: [],
      },
      error: new Error("Body data refresh failed."),
      isError: true,
      isLoading: false,
      isPending: false,
      isSuccess: false,
    });

    render(<BodyPage />);

    expect(screen.getByText("Smoothed weight points: 1")).toBeTruthy();
    expect(screen.getByText("Recomposition points: 1")).toBeTruthy();
    expect(screen.getByText("Weight prediction")).toBeTruthy();
    expect(screen.getByText("Body data refresh failed.")).toBeTruthy();
  });
});
