/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JournalPanel } from "./JournalPanel.tsx";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  deleteMutation: vi.fn(),
  entriesInvalidate: vi.fn(),
  entriesQuery: vi.fn(),
  questionsQuery: vi.fn(),
}));

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
  TimeSeriesChart: () => <div>Journal chart</div>,
}));

const entry = {
  id: "entry-1",
  date: "2026-07-25",
  provider_id: "dofek",
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

  it("shows and reports delete failures while keeping the entry available to retry", () => {
    const deleteError = new Error("Journal entry could not be deleted");
    let onError: ((error: unknown) => void) | undefined;
    const mutate = vi.fn();
    mocks.deleteMutation.mockImplementation((options: { onError?: (error: unknown) => void }) => {
      onError = options.onError;
      return { error: deleteError, isPending: false, mutate };
    });

    render(<JournalPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    act(() => onError?.(deleteError));

    expect(mutate).toHaveBeenCalledWith({ id: "entry-1" });
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
});
