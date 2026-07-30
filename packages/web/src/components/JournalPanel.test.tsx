/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JournalPanel } from "./JournalPanel.tsx";

interface CapturedJournalSeries {
  data: Array<[string, number | null]>;
  accessibilityDescription?: string;
  formatValue?: (value: number) => string;
  name: string;
  visualization?: "line" | "point";
}

interface CapturedChartProps {
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

  it("shows question failures on the trends tab instead of an empty chart state", () => {
    mocks.questionsQuery.mockReturnValue({
      data: undefined,
      error: new Error("Journal questions failed to load"),
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<JournalPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Trends" }));

    expect(screen.getByText("Journal questions failed to load")).toBeDefined();
    expect(screen.queryByText("No numeric journal data to chart.")).toBeNull();
  });

  it("retains the trends empty state alongside a background question failure", () => {
    mocks.questionsQuery.mockReturnValue({
      data: [],
      error: new Error("Journal questions refresh failed"),
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
    });

    render(<JournalPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Trends" }));

    expect(screen.getByText("Journal questions refresh failed")).toBeDefined();
    expect(screen.getByText("No numeric journal data to chart.")).toBeDefined();
  });

  it("renders boolean observations as Yes/No points and numeric observations as lines", () => {
    mocks.questionsQuery.mockReturnValue({
      data: [
        {
          slug: "alcohol",
          display_name: "Alcohol",
          category: "substance",
          data_type: "boolean",
          unit: null,
          sort_order: 1,
        },
        {
          slug: "energy",
          display_name: "Energy",
          category: "wellness",
          data_type: "numeric",
          unit: "/10",
          sort_order: 2,
        },
      ],
      error: null,
      isLoading: false,
    });
    mocks.entriesQuery.mockReturnValue({
      data: [
        {
          ...entry,
          id: "alcohol-yes",
          date: "2026-07-23",
          question_slug: "alcohol",
          display_name: "Alcohol",
          category: "substance",
          data_type: "boolean",
          answer_text: "yes",
          answer_numeric: 1,
        },
        {
          ...entry,
          id: "alcohol-no",
          date: "2026-07-24",
          question_slug: "alcohol",
          display_name: "Alcohol",
          category: "substance",
          data_type: "boolean",
          answer_text: "no",
          answer_numeric: 0,
        },
        {
          ...entry,
          id: "energy-8",
          date: "2026-07-24",
          question_slug: "energy",
          display_name: "Energy",
          data_type: "numeric",
          unit: "/10",
          answer_text: null,
          answer_numeric: 8,
        },
      ],
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
      ],
      accessibilityDescription: "Alcohol is shown as separate Yes/No points.",
      visualization: "point",
    });
    expect(alcohol?.formatValue?.(1)).toBe("Yes");
    expect(alcohol?.formatValue?.(0)).toBe("No");
    expect(alcohol?.formatValue?.(2)).toBe("2");
    expect(energy).toMatchObject({
      data: [["2026-07-24", 8]],
      visualization: "line",
    });
  });
});
