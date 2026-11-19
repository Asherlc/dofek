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
  stagesByDate: vi.fn(),
  insights: vi.fn(),
  processing: vi.fn(),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    sleep: {
      list: { useQuery: mocks.sleepList },
      latestStages: { useQuery: mocks.latestStages },
      stagesByDate: { useQuery: mocks.stagesByDate },
    },
    insights: { compute: { useQuery: mocks.insights } },
    processing: { status: { useQuery: mocks.processing } },
  },
}));

vi.mock("../hooks/useTimeRangePreference.ts", () => ({
  useTimeRangePreference: () => ({ days: 30, setDays: vi.fn() }),
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
    <section aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));
vi.mock("../components/QueryStatePanel.tsx", () => ({
  QueryStatePanel: ({ error }: { error: Error | null }) => <p>{error?.message ?? "Loading"}</p>,
}));
vi.mock("../components/TimeRangeSelector.tsx", () => ({
  TimeRangeSelector: ({ days }: { days: number }) => (
    <fieldset aria-label="Time range">
      <legend>Selected range: {days}d</legend>
    </fieldset>
  ),
}));
vi.mock("../components/ProcessingStatusWidget.tsx", () => ({
  ProcessingStatusWidget: ({ error }: { error: { message: string } | null }) =>
    error ? <p>{error.message}</p> : null,
}));
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
    mocks.stagesByDate.mockImplementation((input?: { date?: string }) =>
      queryResult({ date: input?.date ?? "2026-03-28", stages: [] }),
    );
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

  it("shows one notice when the night and trend queries fail with the same connection error", async () => {
    const message = "We couldn't reach the server. Check your connection and try again.";
    mocks.sleepList.mockReturnValue({
      ...queryResult(undefined),
      error: new Error(message),
      isError: true,
    });
    mocks.stagesByDate.mockReturnValue({
      ...queryResult(undefined),
      error: new Error(message),
      isError: true,
    });
    const { SleepPage } = await import("./SleepPage.tsx");

    const view = render(<SleepPage />);

    expect(screen.getAllByText(message)).toHaveLength(1);
    // A failed list query with no cached data must not render an empty chart
    // or a false empty sources table, while the range/timeline controls stay.
    expect(screen.queryByText("Sleep rows: 0")).toBeNull();
    expect(screen.queryByText("Sources:")).toBeNull();
    expect(screen.getByLabelText("Night date")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Time range" })).toBeTruthy();

    // A cached *empty* payload is still empty after the grouped offline refresh.
    mocks.sleepList.mockReturnValue({
      ...queryResult([]),
      error: new Error(message),
      isError: true,
    });
    view.unmount();
    render(<SleepPage />);

    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.queryByText("Sleep rows: 0")).toBeNull();
    expect(screen.queryByText("Sources:")).toBeNull();
    expect(screen.getByRole("group", { name: "Time range" })).toBeTruthy();
  });

  it("shows one notice when night, trend, insights, and processing all fail with the same connection error", async () => {
    const message = "We couldn't reach the server. Check your connection and try again.";
    mocks.sleepList.mockReturnValue({
      ...queryResult(undefined),
      error: new Error(message),
      isError: true,
    });
    mocks.stagesByDate.mockReturnValue({
      ...queryResult(undefined),
      error: new Error(message),
      isError: true,
    });
    mocks.insights.mockReturnValue({
      ...queryResult(undefined),
      error: new Error(message),
      isError: true,
    });
    mocks.processing.mockReturnValue({
      ...queryResult(undefined),
      error: new Error(message),
      isError: true,
    });
    const { SleepPage } = await import("./SleepPage.tsx");

    const view = render(<SleepPage />);

    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.queryByText("Sleep rows: 0")).toBeNull();
    expect(screen.queryByText("Sources:")).toBeNull();
    expect(screen.getByLabelText("Night date")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Time range" })).toBeTruthy();

    mocks.sleepList.mockReturnValue({
      ...queryResult([]),
      error: new Error(message),
      isError: true,
    });
    view.unmount();
    render(<SleepPage />);

    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.queryByText("Sleep rows: 0")).toBeNull();
    expect(screen.queryByText("Sources:")).toBeNull();
    expect(screen.getByRole("group", { name: "Time range" })).toBeTruthy();
  });

  it("keeps the cached chart and sources when the list shares the connection error", async () => {
    const message = "We couldn't reach the server. Check your connection and try again.";
    mocks.sleepList.mockReturnValue({
      ...queryResult([sleepRow]),
      error: new Error(message),
      isError: true,
    });
    mocks.stagesByDate.mockReturnValue({
      ...queryResult(undefined),
      error: new Error(message),
      isError: true,
    });
    const { SleepPage } = await import("./SleepPage.tsx");

    render(<SleepPage />);

    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.getByText("Sleep rows: 1")).toBeTruthy();
    expect(screen.getByText("Sources: 2026-03-01|oura|Oura Ring")).toBeTruthy();
  });

  it("groups insights and processing with the night failure when the trend fails distinctly", async () => {
    const message = "We couldn't reach the server. Check your connection and try again.";
    mocks.sleepList.mockReturnValue({
      ...queryResult(undefined),
      error: new Error("Sleep history unavailable"),
      isError: true,
    });
    mocks.stagesByDate.mockReturnValue({
      ...queryResult(undefined),
      error: new Error(message),
      isError: true,
    });
    mocks.insights.mockReturnValue({
      ...queryResult(undefined),
      error: new Error(message),
      isError: true,
    });
    mocks.processing.mockReturnValue({
      ...queryResult(undefined),
      error: new Error(message),
      isError: true,
    });
    const { SleepPage } = await import("./SleepPage.tsx");

    render(<SleepPage />);

    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.getByText("Sleep history unavailable")).toBeTruthy();
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
    mocks.stagesByDate.mockReturnValue({
      ...queryResult(undefined),
      error: new Error("Latest stages unavailable"),
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
    mocks.stagesByDate.mockReturnValue({
      ...queryResult({ date: "2026-03-27", stages: [{ stage: "deep" }] }),
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
    expect(screen.getByText("Refresh failed: Latest stages refresh failed")).toBeTruthy();
    expect(screen.getByText("Insight: sleep-effect")).toBeTruthy();
    expect(screen.queryByText("Sleep history refresh failed")).toBeNull();
    expect(screen.queryByText("Latest stages refresh failed")).toBeNull();
    expect(screen.queryByText("Sleep insights refresh failed")).toBeNull();
  });

  it("uses the latest response date independently of trend range and orders the timeline above sources", async () => {
    mocks.stagesByDate.mockImplementation((input?: { date?: string }) =>
      queryResult({ date: input?.date ?? "2026-03-28", stages: [] }),
    );
    const { SleepPage } = await import("./SleepPage.tsx");

    render(<SleepPage />);

    expect(mocks.stagesByDate).toHaveBeenCalledWith(undefined);
    expect(screen.getByLabelText("Night date").getAttribute("value")).toBe("2026-03-28");
    expect(screen.getByRole("heading", { name: "Night’s Stages" })).toBeTruthy();
    const headings = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(headings.indexOf("Night’s Stages")).toBeLessThan(headings.indexOf("Data Sources"));
  });

  it("keeps navigation available for empty or failed selected dates and requests the chosen day", async () => {
    mocks.stagesByDate.mockImplementation((input?: { date?: string }) =>
      input?.date === "2026-03-27"
        ? { ...queryResult(undefined), error: new Error("Stages unavailable"), isError: true }
        : queryResult({ date: input?.date ?? "2026-03-31", stages: [] }),
    );
    const { SleepPage } = await import("./SleepPage.tsx");

    render(<SleepPage />);
    const dateInput = screen.getByLabelText("Night date");
    expect(screen.getByRole("button", { name: "Previous day" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next day" })).toBeDisabled();

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(dateInput, { target: { value: "2026-03-27" } });

    expect(mocks.stagesByDate).toHaveBeenLastCalledWith({ date: "2026-03-27" });
    expect(screen.getByRole("button", { name: "Previous day" })).toBeEnabled();
  });

  it("places independently browsed night stages before the trend range grouped with the trend chart", async () => {
    const { SleepPage } = await import("./SleepPage.tsx");

    render(<SleepPage />);

    const nightStages = screen.getByRole("heading", { name: "Night’s Stages" });
    const trendRange = screen.getByRole("group", { name: "Time range" });
    const trendChartSection = screen.getByRole("region", { name: "Sleep Stages" });
    expect(
      nightStages.compareDocumentPosition(trendRange) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(trendChartSection.contains(trendRange)).toBe(true);
  });
});
