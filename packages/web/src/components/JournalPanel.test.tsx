/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JournalPanel } from "./JournalPanel.tsx";
import { emptyJournalTrendEvidence } from "./journal-trend-test-fixtures.ts";

interface CapturedJournalSeries {
  data: Array<[string, number | null]>;
  accessibilityDescription?: string;
  formatValue?: (value: number) => string;
  missingDates?: string[];
  name: string;
  visualization?: "line" | "point";
}

interface CapturedChartProps {
  accessibilityDescription?: string;
  series: CapturedJournalSeries[];
}

const mocks = vi.hoisted(() => {
  const chartProps: CapturedChartProps[] = [];
  return {
    chartProps,
    captureException: vi.fn(),
    deleteMutation: vi.fn(),
    entriesInvalidate: vi.fn(),
    entriesQuery: vi.fn(),
    questionsQuery: vi.fn(),
    trendsQuery: vi.fn(),
  };
});

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mocks.captureException,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      journal: {
        entries: {
          invalidate: mocks.entriesInvalidate,
        },
      },
    }),
    journal: {
      entries: {
        useQuery: mocks.entriesQuery,
      },
      questions: {
        useQuery: mocks.questionsQuery,
      },
      trends: {
        useQuery: mocks.trendsQuery,
      },
      delete: {
        useMutation: mocks.deleteMutation,
      },
    },
  },
}));

vi.mock("./AddJournalEntryModal.tsx", () => ({
  AddJournalEntryModal: () => <div>Add journal entry form</div>,
}));

vi.mock("./DofekChart.tsx", () => ({
  ChartRangeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("./TimeRangeSelector.tsx", () => ({
  TimeRangeSelector: () => <div>Time range</div>,
}));

vi.mock("./TimeSeriesChart.tsx", () => ({
  TimeSeriesChart: (props: CapturedChartProps) => {
    mocks.chartProps.push(props);
    return <div>Journal chart</div>;
  },
}));

const entry = {
  id: "entry-1",
  date: "2026-07-25",
  source: { providerId: "dofek", label: "Dofek" },
  question_slug: "mood",
  display_name: "Mood",
  category: "wellness",
  data_type: "text",
  unit: null,
  answer_text: "Calm",
  answer_numeric: null,
  impact_score: null,
};

describe("JournalPanel", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.chartProps.length = 0;
    mocks.captureException.mockReset();
    mocks.entriesInvalidate.mockReset();
    mocks.entriesQuery.mockReset();
    mocks.entriesQuery.mockReturnValue({ data: [entry], error: null, isLoading: false });
    mocks.questionsQuery.mockReset();
    mocks.questionsQuery.mockReturnValue({ data: [], error: null, isLoading: false });
    mocks.trendsQuery.mockReset();
    mocks.trendsQuery.mockReturnValue({
      data: emptyJournalTrendEvidence,
      error: null,
      isLoading: false,
    });
    mocks.deleteMutation.mockReset();
    mocks.deleteMutation.mockReturnValue({ error: null, isPending: false, mutate: vi.fn() });
  });

  it("shows an initial entries failure instead of the empty state", () => {
    const refetch = vi.fn();
    mocks.entriesQuery.mockReturnValue({
      data: undefined,
      error: new Error("Journal entries are unavailable"),
      isFetching: false,
      isLoading: false,
      refetch,
    });

    render(<JournalPanel />);

    expect(screen.getByText("Journal entries are unavailable")).toBeDefined();
    expect(screen.queryByText("No journal entries yet.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry journal entries" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("retains cached entries during a background refresh failure", () => {
    mocks.entriesQuery.mockReturnValue({
      data: [entry],
      error: new Error("Journal refresh failed"),
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<JournalPanel />);

    expect(screen.getByText("Mood")).toBeDefined();
    expect(screen.getByText("Calm")).toBeDefined();
    expect(screen.getByText("Journal refresh failed")).toBeDefined();
  });

  it("shows journal answers without presenting provider impact scores as per-entry effects", () => {
    mocks.entriesQuery.mockReturnValue({
      data: [
        {
          ...entry,
          id: "alcohol",
          source: { providerId: "manual_review", label: "Manual review" },
          question_slug: "alcohol",
          display_name: "Alcohol",
          data_type: "boolean",
          answer_numeric: 1,
          answer_text: null,
          impact_score: 0.4,
        },
        {
          ...entry,
          id: "late-meal",
          source: { providerId: "whoop", label: "WHOOP (Cloud)" },
          question_slug: "late_meal",
          display_name: "Late meal",
          data_type: "boolean",
          answer_numeric: 0,
          answer_text: null,
          impact_score: -0.3,
        },
      ],
      error: null,
      isLoading: false,
    });

    render(<JournalPanel />);

    const alcoholRow = screen.getByText("Alcohol").parentElement?.parentElement;
    const lateMealRow = screen.getByText("Late meal").parentElement?.parentElement;
    expect(alcoholRow?.textContent).toContain("Manual review");
    expect(alcoholRow?.textContent).not.toContain("manual_review");
    expect(lateMealRow?.textContent).toContain("WHOOP (Cloud)");
    expect(lateMealRow?.textContent).not.toContain("whoop");
    const yesAnswer = screen.getByText("Yes");
    const noAnswer = screen.getByText("No");
    expect(yesAnswer.classList.contains("bg-surface-hover")).toBe(true);
    expect(yesAnswer.classList.contains("text-muted")).toBe(true);
    expect(noAnswer.classList.contains("bg-surface-hover")).toBe(true);
    expect(noAnswer.classList.contains("text-muted")).toBe(true);
  });

  it("reveals raw source IDs only through accessible technical details", () => {
    mocks.entriesQuery.mockReturnValue({
      data: [
        {
          ...entry,
          source: { providerId: "manual_review", label: "Manual review" },
        },
      ],
      error: null,
      isLoading: false,
    });

    render(<JournalPanel />);

    expect(screen.getByText("Manual review")).toBeDefined();
    expect(screen.queryByText("manual_review")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Show technical source details for Manual review" }),
    );

    expect(screen.getByText("Provider ID: manual_review")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Hide technical source details for Manual review" }),
    ).toBeDefined();
  });

  it("paginates journal entries", () => {
    mocks.entriesQuery.mockReturnValue({
      data: Array.from({ length: 21 }, (_, index) => ({
        ...entry,
        id: `entry-${index + 1}`,
        display_name: `Entry ${index + 1}`,
      })),
      error: null,
      isLoading: false,
    });

    render(<JournalPanel />);

    expect(screen.getByText("Entry 1")).toBeDefined();
    expect(screen.queryByText("Entry 21")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next journal entries page" }));

    expect(screen.queryByText("Entry 1")).toBeNull();
    expect(screen.getByText("Entry 21")).toBeDefined();
  });

  it("shows and reports delete failures while keeping the entry available to retry", () => {
    const deleteError = new Error("Journal entry could not be deleted");
    let onError: ((error: unknown) => void) | undefined;
    let meta: unknown;
    const mutate = vi.fn();
    mocks.deleteMutation.mockImplementation(
      (options: { meta?: unknown; onError?: (error: unknown) => void }) => {
        meta = options.meta;
        onError = options.onError;
        return { error: deleteError, isPending: false, mutate };
      },
    );

    render(<JournalPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    act(() => onError?.(deleteError));

    expect(mutate).toHaveBeenCalledWith({ id: "entry-1" });
    expect(meta).toEqual({ errorReportedLocally: true });
    expect(screen.getByText(deleteError.message)).toBeDefined();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDefined();
    expect(mocks.captureException).toHaveBeenCalledWith(deleteError, {
      operation: "journal.delete",
    });
  });

  it("shows trend-evidence failures instead of the empty chart state", () => {
    mocks.trendsQuery.mockReturnValue({
      data: undefined,
      error: new Error("Journal trends failed to load"),
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<JournalPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Trends" }));

    expect(screen.getByText("Journal trends failed to load")).toBeDefined();
    expect(screen.queryByText("No numeric journal data to chart.")).toBeNull();
  });

  it("retains the trends empty state alongside a background refresh failure", () => {
    mocks.trendsQuery.mockReturnValue({
      data: emptyJournalTrendEvidence,
      error: new Error("Journal trends refresh failed"),
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<JournalPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Trends" }));

    expect(screen.getByText("Journal trends refresh failed")).toBeDefined();
    expect(screen.getByText("No numeric journal data to chart.")).toBeDefined();
  });

  it("shows an unavailable state when the trends query settles without evidence", () => {
    mocks.trendsQuery.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
    });

    render(<JournalPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Trends" }));

    expect(screen.getByText("Journal trend evidence is unavailable.")).toBeDefined();
  });

  it("renders server-authored dates, gaps, exact values, and uncertainty evidence", () => {
    mocks.trendsQuery.mockReturnValue({
      data: {
        window: {
          startDate: "2026-07-23",
          endDate: "2026-07-25",
          dayCount: 3,
          gapRepresentation: "explicit_daily",
        },
        statement:
          "3 exact observations across 2 of 3 days. Missing days indicate no journal value was recorded.",
        uncertainty: {
          status: "unavailable",
          statement: "Uncertainty interval: not available for raw journal observations.",
        },
        series: [
          {
            questionSlug: "alcohol",
            displayName: "Alcohol",
            dataType: "boolean",
            unit: null,
            observationCount: 2,
            observedDayCount: 2,
            missingDayCount: 1,
            statement: "2 exact observations across 2 of 3 days; 1 day has no recorded value.",
            points: [
              {
                date: "2026-07-23",
                value: 1,
                source: { providerId: "dofek", label: "Dofek" },
              },
              {
                date: "2026-07-24",
                value: 0,
                source: { providerId: "whoop", label: "WHOOP (Cloud)" },
              },
              { date: "2026-07-25", value: null, source: null },
            ],
          },
          {
            questionSlug: "energy",
            displayName: "Energy",
            dataType: "numeric",
            unit: "/10",
            observationCount: 1,
            observedDayCount: 1,
            missingDayCount: 2,
            statement: "1 exact observation across 1 of 3 days; 2 days have no recorded value.",
            points: [
              { date: "2026-07-23", value: null, source: null },
              {
                date: "2026-07-24",
                value: 8,
                source: { providerId: "dofek", label: "Dofek" },
              },
              { date: "2026-07-25", value: null, source: null },
            ],
          },
        ],
      },
      error: null,
      isLoading: false,
    });

    render(<JournalPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Trends" }));

    const chart = mocks.chartProps.at(-1);
    const alcohol = chart?.series.find((series) => series.name === "Alcohol");
    const energy = chart?.series.find((series) => series.name === "Energy");

    expect(alcohol).toMatchObject({
      data: [
        ["2026-07-23", 1],
        ["2026-07-24", 0],
        ["2026-07-25", null],
      ],
      accessibilityDescription: "Alcohol is shown as separate Yes/No points.",
      visualization: "point",
    });
    expect(alcohol?.formatValue?.(1)).toBe("Yes");
    expect(alcohol?.formatValue?.(0)).toBe("No");
    expect(alcohol?.formatValue?.(2)).toBe("2");
    expect(energy).toMatchObject({
      data: [
        ["2026-07-23", null],
        ["2026-07-24", 8],
        ["2026-07-25", null],
      ],
      visualization: "line",
    });
    expect(chart?.accessibilityDescription).toContain("Thu, Jul 23, 2026 to Sat, Jul 25, 2026");
    expect(screen.getByText("Thu, Jul 23, 2026 – Sat, Jul 25, 2026")).toBeDefined();
    expect(
      screen.getByText(
        "3 exact observations across 2 of 3 days. Missing days indicate no journal value was recorded.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText("Uncertainty interval: not available for raw journal observations."),
    ).toBeDefined();
    expect(
      screen.getByText("2 exact observations across 2 of 3 days; 1 day has no recorded value."),
    ).toBeDefined();
    expect(screen.getByText("Missing: Sat, Jul 25, 2026")).toBeDefined();
    expect(screen.getByText("Yes · Dofek")).toBeDefined();
    expect(screen.getByText("No · WHOOP (Cloud)")).toBeDefined();
    expect(screen.getByText("8 /10 · Dofek")).toBeDefined();
  });

  it("renders same-day numeric provider observations as separate points", () => {
    mocks.trendsQuery.mockReturnValue({
      data: {
        window: {
          startDate: "2026-07-24",
          endDate: "2026-07-25",
          dayCount: 2,
          gapRepresentation: "explicit_daily",
        },
        statement: "3 exact observations across 2 of 2 days.",
        uncertainty: {
          status: "unavailable",
          statement: "Uncertainty interval: not available for raw journal observations.",
        },
        series: [
          {
            questionSlug: "energy",
            displayName: "Energy",
            dataType: "numeric",
            unit: "/10",
            observationCount: 3,
            observedDayCount: 2,
            missingDayCount: 0,
            statement: "3 exact observations across 2 of 2 days; 0 days have no recorded value.",
            points: [
              {
                date: "2026-07-24",
                value: 7,
                source: { providerId: "dofek", label: "Dofek" },
              },
              {
                date: "2026-07-24",
                value: 8,
                source: { providerId: "whoop", label: "WHOOP (Cloud)" },
              },
              {
                date: "2026-07-25",
                value: 9,
                source: { providerId: "dofek", label: "Dofek" },
              },
            ],
          },
        ],
      },
      error: null,
      isLoading: false,
    });

    render(<JournalPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Trends" }));

    expect(mocks.chartProps.at(-1)?.series[0]).toMatchObject({
      accessibilityDescription:
        "Energy is shown as separate points because multiple sources recorded the same date.",
      visualization: "point",
    });
  });

  it("labels sparse All-history gaps as counts instead of exact missing dates", () => {
    mocks.trendsQuery.mockReturnValue({
      data: {
        window: {
          startDate: "2006-06-28",
          endDate: "2026-07-05",
          dayCount: 7313,
          gapRepresentation: "count_only",
        },
        statement:
          "1 exact observation across 1 of 7313 days. Missing days are summarized by count for the all-history window.",
        uncertainty: {
          status: "unavailable",
          statement: "Uncertainty interval: not available for raw journal observations.",
        },
        series: [
          {
            questionSlug: "energy",
            displayName: "Energy",
            dataType: "numeric",
            unit: "/10",
            observationCount: 1,
            observedDayCount: 1,
            missingDayCount: 7312,
            statement:
              "1 exact observation across 1 of 7313 days; 7312 days have no recorded value.",
            points: [
              {
                date: "2006-06-28",
                value: 6,
                source: { providerId: "dofek", label: "Dofek" },
              },
            ],
          },
        ],
      },
      error: null,
      isLoading: false,
    });

    render(<JournalPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Trends" }));

    expect(mocks.chartProps.at(-1)?.series[0]?.missingDates).toEqual([]);
    expect(mocks.chartProps.at(-1)?.accessibilityDescription).toContain(
      "Missing days are summarized by count for All history",
    );
    expect(
      screen.getByText(
        "Missing-day dates are summarized by count for All history: 7312 days. Choose a finite range to inspect exact missing dates.",
      ),
    ).toBeDefined();
  });
});
