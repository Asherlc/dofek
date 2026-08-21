/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Insight } from "../../components/CorrelationCard.tsx";
import { TRAINING_OVERVIEW_QUERY_OPTIONS } from "../../lib/trainingQueryOptions.ts";

type MockInsightsQueryResult = {
  data: Insight[] | undefined;
  isLoading: boolean;
  error: Error | null;
};

const mockInsightsQuery = vi.hoisted(() =>
  vi.fn<() => MockInsightsQueryResult>(() => ({ data: [], isLoading: false, error: null })),
);
const state = vi.hoisted<{
  selectedDays: number | null;
  queryCalls: Array<{ name: string; input: unknown; options?: unknown }>;
}>(() => ({
  selectedDays: 90,
  queryCalls: [],
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => null,
}));

vi.mock("../../lib/trainingDaysContext.ts", () => ({
  useTrainingDays: () => ({ days: state.selectedDays }),
}));

vi.mock("../../components/TrainingCalendar.tsx", () => ({
  TrainingCalendar: () => <div>Training calendar</div>,
}));

vi.mock("../../components/PmcChart.tsx", () => ({
  PmcChart: () => <div>PMC chart</div>,
}));

vi.mock("../../components/TrainingInsightsPanel.tsx", () => ({
  TrainingInsightsPanel: () => <div>Volume and zones</div>,
}));

vi.mock("../../components/RecentActivitiesSection.tsx", () => ({
  RecentActivitiesSection: () => <div>Recent activities</div>,
}));

vi.mock("../../components/CorrelationCard.tsx", async () => {
  const actual = await vi.importActual<typeof import("../../components/CorrelationCard.tsx")>(
    "../../components/CorrelationCard.tsx",
  );
  return {
    ...actual,
    CorrelationCard: ({ insight }: { insight: Insight }) => (
      <div data-testid="correlation-card">{insight.message}</div>
    ),
    CorrelationCardSkeleton: () => <div data-testid="correlation-card-skeleton" />,
  };
});

vi.mock("../../lib/trpc.ts", () => ({
  trpc: {
    pmc: {
      chart: {
        useQuery: (input: unknown, options?: unknown) => {
          state.queryCalls.push({ name: "pmc", input, options });
          return { data: { data: [], model: null }, isLoading: false };
        },
      },
    },
    calendar: {
      calendarData: {
        useQuery: (input: unknown, options?: unknown) => {
          state.queryCalls.push({ name: "calendarData", input, options });
          return { data: [], isLoading: false };
        },
      },
    },
    insights: {
      compute: { useQuery: mockInsightsQuery },
    },
  },
}));

function makeInsight(overrides: Partial<Insight> & Pick<Insight, "id" | "action">): Insight {
  return {
    type: "conditional",
    confidence: "strong",
    metric: "next-day heart rate variability",
    message: "Test insight",
    detail: "detail",
    whenTrue: { mean: 50, n: 10 },
    whenFalse: { mean: 40, n: 10 },
    effectSize: 0.5,
    pValue: 0.01,
    ...overrides,
  };
}

async function importTrainingOverview() {
  const mod = await import("./index.tsx");
  return mod.TrainingOverview;
}

describe("TrainingOverview training insights", () => {
  beforeEach(() => {
    mockInsightsQuery.mockClear();
    mockInsightsQuery.mockReturnValue({ data: [], isLoading: false, error: null });
    state.selectedDays = 90;
    state.queryCalls.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it("shows skeleton cards while insights are loading", async () => {
    mockInsightsQuery.mockReturnValue({ data: undefined, isLoading: true, error: null });

    const TrainingOverview = await importTrainingOverview();
    render(<TrainingOverview />);

    expect(screen.getByText("Training Insights")).toBeTruthy();
    expect(screen.getAllByTestId("correlation-card-skeleton")).toHaveLength(2);
  });

  it("renders training insights and hides non-training insights", async () => {
    mockInsightsQuery.mockReturnValue({
      data: [
        makeInsight({
          id: "training",
          action: "30+ min exercise",
          message: "Exercise boosts next-day heart rate variability",
        }),
        makeInsight({
          id: "sleep",
          action: "7+ hours of sleep",
          message: "Sleep boosts next-day heart rate variability",
        }),
      ],
      isLoading: false,
      error: null,
    });

    const TrainingOverview = await importTrainingOverview();
    render(<TrainingOverview />);

    expect(screen.getByText("Training Insights")).toBeTruthy();
    expect(screen.getByText("Exercise boosts next-day heart rate variability")).toBeTruthy();
    expect(screen.queryByText("Sleep boosts next-day heart rate variability")).toBeNull();
    expect(screen.getAllByTestId("correlation-card")).toHaveLength(1);
  });

  it("hides the section when there are no training insights", async () => {
    mockInsightsQuery.mockReturnValue({
      data: [
        makeInsight({
          id: "sleep",
          action: "7+ hours of sleep",
          message: "Sleep boosts next-day heart rate variability",
        }),
      ],
      isLoading: false,
      error: null,
    });

    const TrainingOverview = await importTrainingOverview();
    render(<TrainingOverview />);

    expect(screen.queryByText("Training Insights")).toBeNull();
    expect(screen.queryByTestId("correlation-card")).toBeNull();
  });

  it("requests at least 90 days of insight data", async () => {
    state.selectedDays = 30;

    const TrainingOverview = await importTrainingOverview();
    render(<TrainingOverview />);

    expect(mockInsightsQuery).toHaveBeenCalledTimes(1);
    expect(mockInsightsQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        days: 90,
        endDate: expect.any(String),
      }),
      expect.objectContaining({
        staleTime: TRAINING_OVERVIEW_QUERY_OPTIONS.staleTime,
        gcTime: TRAINING_OVERVIEW_QUERY_OPTIONS.gcTime,
      }),
    );
    expect(state.queryCalls).toEqual([
      expect.objectContaining({ name: "pmc", input: { days: 30 } }),
      expect.objectContaining({ name: "calendarData", input: { days: 30 } }),
    ]);
  });

  it("passes null for All to selected-range and support queries", async () => {
    state.selectedDays = null;

    const TrainingOverview = await importTrainingOverview();
    render(<TrainingOverview />);

    expect(state.queryCalls).toEqual([
      expect.objectContaining({ name: "pmc", input: { days: null } }),
      expect.objectContaining({ name: "calendarData", input: { days: null } }),
    ]);
    expect(mockInsightsQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        days: null,
        endDate: expect.any(String),
      }),
      expect.objectContaining({
        staleTime: TRAINING_OVERVIEW_QUERY_OPTIONS.staleTime,
        gcTime: TRAINING_OVERVIEW_QUERY_OPTIONS.gcTime,
      }),
    );
  });
});
