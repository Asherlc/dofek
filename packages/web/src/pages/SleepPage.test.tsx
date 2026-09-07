/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryResult<T> = {
  data: T | undefined;
  error: Error | null;
  isError: boolean;
  isLoading: boolean;
};

function queryResult<T>(data: T | undefined): QueryResult<T> {
  return { data, error: null, isError: false, isLoading: false };
}

const mocks = vi.hoisted(() => ({
  sleepList: vi.fn(),
  latestStages: vi.fn(),
  sleepNeed: vi.fn(),
  sleepPerformance: vi.fn(),
  insights: vi.fn(),
  processing: vi.fn(),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    sleep: {
      list: { useQuery: mocks.sleepList },
      latestStages: { useQuery: mocks.latestStages },
    },
    sleepNeed: {
      calculateV2: { useQuery: mocks.sleepNeed },
      performance: { useQuery: mocks.sleepPerformance },
    },
    insights: { compute: { useQuery: mocks.insights } },
    processing: { status: { useQuery: mocks.processing } },
  },
}));

vi.mock("../hooks/useTimeRangePreference.ts", () => ({
  useTimeRangePreference: () => ({ days: 30, description: "Last 30 days", setDays: vi.fn() }),
}));
vi.mock("../hooks/useTodayQueryDate.ts", () => ({ useTodayQueryDate: () => "2026-03-31" }));
vi.mock("../hooks/useProcessingStatus.ts", () => ({
  useProcessingStatus: () => mocks.processing(),
}));
vi.mock("../components/DofekChart.tsx", () => ({
  ChartRangeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({
    children,
    headerChildren,
  }: {
    children: React.ReactNode;
    headerChildren: React.ReactNode;
  }) => (
    <main>
      {headerChildren}
      {children}
    </main>
  ),
}));
vi.mock("../components/PageSection.tsx", () => ({
  PageSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("../components/QueryStatePanel.tsx", () => ({
  QueryStatePanel: ({ error }: { error: Error | null }) => <p>{error?.message ?? "Loading"}</p>,
}));
vi.mock("../components/TimeRangeSelector.tsx", () => ({
  TimeRangeSelector: ({ description }: { description: string }) => <p>{description}</p>,
}));
vi.mock("../components/ProcessingStatusWidget.tsx", () => ({ ProcessingStatusWidget: () => null }));
vi.mock("../components/SleepOverviewCards.tsx", () => ({ SleepOverviewCards: () => null }));
vi.mock("../components/SleepChart.tsx", () => ({
  SleepChart: ({ data }: { data: unknown[] }) => <p>Sleep rows: {data.length}</p>,
}));
vi.mock("../components/SleepDataSourcesTable.tsx", () => ({
  SleepDataSourcesTable: ({ rows }: { rows: Array<Record<string, unknown>> }) => (
    <p>Sources: {rows.map((row) => `${row.date}|${row.providerId}|${row.sourceName}`).join(",")}</p>
  ),
}));
vi.mock("../components/Hypnogram.tsx", () => ({ Hypnogram: () => <p>Hypnogram</p> }));
vi.mock("../components/CorrelationCard.tsx", () => ({
  CorrelationCard: ({ insight }: { insight: { id: string } }) => <p>Insight: {insight.id}</p>,
  CorrelationCardSkeleton: () => <p>Insight loading</p>,
}));

const sleepRow = {
  date: undefined,
  started_at: "2026-03-01T23:30:00.000Z",
  ended_at: "2026-03-02T07:00:00.000Z",
  timezone: "America/Los_Angeles",
  start_utc_offset_minutes: -480,
  end_utc_offset_minutes: -480,
  local_time_source: "provider_timezone",
  duration_minutes: 450,
  deep_minutes: 90,
  rem_minutes: 100,
  light_minutes: 230,
  awake_minutes: 30,
  efficiency_pct: 92,
  provider_id: "oura",
  source_name: "Oura Ring",
  source_providers: ["oura"],
  selected_session_id: "session-1",
  overlapping_sessions: [],
  staging_available: true,
};

describe("SleepPage", () => {
  beforeEach(() => {
    mocks.sleepList.mockReturnValue(queryResult([sleepRow]));
    mocks.latestStages.mockReturnValue(queryResult([]));
    mocks.sleepNeed.mockReturnValue(queryResult(undefined));
    mocks.sleepPerformance.mockReturnValue(queryResult(undefined));
    mocks.insights.mockReturnValue(queryResult([]));
    mocks.processing.mockReturnValue(queryResult(undefined));
  });

  it("maps canonical sleep rows and shows only usable sleep insights", async () => {
    mocks.insights.mockReturnValue(
      queryResult([
        { id: "sleep-effect", metric: "sleep duration", confidence: "high", effectSize: 0.3 },
        { id: "training-effect", metric: "training load", confidence: "high", effectSize: 0.8 },
        {
          id: "insufficient-effect",
          metric: "REM sleep",
          confidence: "insufficient",
          effectSize: 0.5,
        },
      ]),
    );
    const { SleepPage } = await import("./SleepPage.tsx");

    render(<SleepPage />);

    expect(screen.getByText("Sleep rows: 1")).toBeTruthy();
    expect(screen.getByText("Sources: 2026-03-01|oura|Oura Ring")).toBeTruthy();
    expect(screen.getByText("Insight: sleep-effect")).toBeTruthy();
    expect(screen.queryByText("Insight: training-effect")).toBeNull();
    expect(screen.queryByText("Insight: insufficient-effect")).toBeNull();
  });

  it("shows independent errors only where no cached result is available", async () => {
    mocks.sleepList.mockReturnValue({
      ...queryResult(undefined),
      error: new Error("Sleep history unavailable"),
      isError: true,
    });
    mocks.latestStages.mockReturnValue({
      ...queryResult(undefined),
      error: new Error("Latest stages unavailable"),
      isError: true,
    });
    mocks.sleepNeed.mockReturnValue({
      ...queryResult(undefined),
      error: new Error("Sleep need unavailable"),
      isError: true,
    });
    mocks.sleepPerformance.mockReturnValue({
      ...queryResult(undefined),
      error: new Error("Sleep performance unavailable"),
      isError: true,
    });
    mocks.insights.mockReturnValue({
      ...queryResult(undefined),
      error: new Error("Sleep insights unavailable"),
      isError: true,
    });
    const { SleepPage } = await import("./SleepPage.tsx");

    render(<SleepPage />);

    for (const message of [
      "Sleep history unavailable",
      "Latest stages unavailable",
      "Sleep need unavailable",
      "Sleep performance unavailable",
      "Sleep insights unavailable",
    ]) {
      expect(screen.getByText(message)).toBeTruthy();
    }
  });

  it("keeps cached results visible during background refresh errors", async () => {
    mocks.sleepList.mockReturnValue({
      ...queryResult([sleepRow]),
      error: new Error("Sleep history refresh failed"),
      isError: true,
    });
    mocks.latestStages.mockReturnValue({
      ...queryResult([{ stage: "deep" }]),
      error: new Error("Latest stages refresh failed"),
      isError: true,
    });
    mocks.insights.mockReturnValue({
      ...queryResult([
        { id: "sleep-effect", metric: "sleep", confidence: "high", effectSize: 0.3 },
      ]),
      error: new Error("Sleep insights refresh failed"),
      isError: true,
    });
    const { SleepPage } = await import("./SleepPage.tsx");

    render(<SleepPage />);

    expect(screen.getByText("Sleep rows: 1")).toBeTruthy();
    expect(screen.getByText("Hypnogram")).toBeTruthy();
    expect(screen.getByText("Insight: sleep-effect")).toBeTruthy();
    expect(screen.queryByText("Sleep history refresh failed")).toBeNull();
    expect(screen.queryByText("Latest stages refresh failed")).toBeNull();
    expect(screen.queryByText("Sleep insights refresh failed")).toBeNull();
  });
});
