/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Period {
  id: string;
  startDate: string;
  endDate: string | null;
  durationDays: number | null;
  durationLabel: string | null;
  notes: string | null;
}

interface PhaseData {
  phase: "menstrual" | null;
  dayOfCycle: number | null;
  cycleLength: number | null;
  estimate: {
    phaseLabel: string;
    cycleDayLabel: string;
    dayBasisLabel: string;
    methodLabel: string;
    uncertaintyLabel: string;
    limitationLabel: string;
  } | null;
  availability: {
    status: "estimated" | "sparse-history" | "irregular-history";
    label: string;
  };
}

interface TestState {
  capturedComponent: ComponentType | null;
  phaseQuery: {
    data: PhaseData | undefined;
    isLoading: boolean;
    error: Error | null;
  };
  historyQuery: {
    data: Period[] | undefined;
    isLoading: boolean;
    error: Error | null;
  };
  mutationError: Error | null;
  mutationInput: { startDate: string; notes: string | null } | null;
  updateMutationError: Error | null;
  updateMutationInput: {
    id: string;
    startDate: string;
    endDate: string | null;
    notes: string | null;
  } | null;
  deleteMutationError: Error | null;
  deleteMutationInput: { id: string } | null;
  captureException: ReturnType<typeof vi.fn>;
  invalidateCurrentPhase: ReturnType<typeof vi.fn>;
  invalidateHistory: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted<TestState>(() => ({
  capturedComponent: null,
  phaseQuery: {
    data: undefined,
    isLoading: false,
    error: null,
  },
  historyQuery: {
    data: [],
    isLoading: false,
    error: null,
  },
  mutationError: null,
  mutationInput: null,
  updateMutationError: null,
  updateMutationInput: null,
  deleteMutationError: null,
  deleteMutationInput: null,
  captureException: vi.fn(),
  invalidateCurrentPhase: vi.fn(),
  invalidateHistory: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    search,
    to,
  }: {
    children: ReactNode;
    search?: { tab?: string };
    to: string;
  }) => <a href={search?.tab ? `${to}?tab=${search.tab}` : to}>{children}</a>,
  createFileRoute: () => (options: { component: ComponentType }) => {
    state.capturedComponent = options.component;
    return {};
  },
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: state.captureException,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    menstrualCycle: {
      currentPhase: {
        useQuery: () => state.phaseQuery,
      },
      history: {
        useQuery: () => state.historyQuery,
      },
      logPeriod: {
        useMutation: (options: {
          onError?: (error: Error) => void;
          onSettled?: () => Promise<void> | void;
        }) => ({
          mutate: (input: NonNullable<TestState["mutationInput"]>) => {
            state.mutationInput = input;
            if (state.mutationError) options.onError?.(state.mutationError);
            void options.onSettled?.();
          },
          isPending: false,
          error: state.mutationError,
        }),
      },
      updatePeriod: {
        useMutation: (options: {
          onError?: (error: Error) => void;
          onSettled?: () => Promise<void> | void;
        }) => ({
          mutate: (input: NonNullable<TestState["updateMutationInput"]>) => {
            state.updateMutationInput = input;
            if (state.updateMutationError) options.onError?.(state.updateMutationError);
            void options.onSettled?.();
          },
          isPending: false,
          error: state.updateMutationError,
          reset: vi.fn(),
        }),
      },
      deletePeriod: {
        useMutation: (options: {
          onError?: (error: Error) => void;
          onSettled?: () => Promise<void> | void;
        }) => ({
          mutate: (input: { id: string }) => {
            state.deleteMutationInput = input;
            if (state.deleteMutationError) options.onError?.(state.deleteMutationError);
            void options.onSettled?.();
          },
          isPending: false,
          error: state.deleteMutationError,
          reset: vi.fn(),
        }),
      },
    },
    useUtils: () => ({
      menstrualCycle: {
        currentPhase: { invalidate: state.invalidateCurrentPhase },
        history: { invalidate: state.invalidateHistory },
      },
    }),
  },
}));

import "./cycle.tsx";

function renderCyclePage() {
  if (!state.capturedComponent) throw new Error("Cycle route component was not captured");
  const CyclePage = state.capturedComponent;
  return render(<CyclePage />);
}

describe("CyclePage", () => {
  beforeEach(() => {
    state.phaseQuery.data = undefined;
    state.phaseQuery.isLoading = false;
    state.phaseQuery.error = null;
    state.historyQuery.data = [];
    state.historyQuery.isLoading = false;
    state.historyQuery.error = null;
    state.mutationError = null;
    state.mutationInput = null;
    state.updateMutationError = null;
    state.updateMutationInput = null;
    state.deleteMutationError = null;
    state.deleteMutationInput = null;
    vi.clearAllMocks();
  });

  it("renders separate loading and empty states", () => {
    state.phaseQuery.isLoading = true;

    renderCyclePage();

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.getByText("No periods logged yet.")).toBeTruthy();
  });

  it("shows the current-phase server error instead of an empty state", () => {
    state.phaseQuery.error = new Error("Current cycle data is unavailable.");

    renderCyclePage();

    expect(screen.getByText("Current cycle data is unavailable.")).toBeTruthy();
    expect(screen.queryByText(/No active cycle detected/)).toBeNull();
  });

  it("shows the history server error instead of hiding the section", () => {
    state.historyQuery.data = undefined;
    state.historyQuery.error = new Error("Period history could not be loaded.");

    renderCyclePage();

    expect(screen.getByText("Period History")).toBeTruthy();
    expect(screen.getByText("Period history could not be loaded.")).toBeTruthy();
  });

  it("shows the tracking-only safety boundary beside the phase estimate", () => {
    state.phaseQuery.data = {
      phase: "menstrual",
      dayOfCycle: 3,
      cycleLength: 28,
      estimate: {
        phaseLabel: "Estimated Menstrual phase",
        cycleDayLabel: "Day 3 of an estimated 28-day cycle",
        dayBasisLabel: "Cycle day is counted from the latest recorded period start.",
        methodLabel: "Phase and cycle length use the average of 3 completed cycles.",
        uncertaintyLabel: "Recorded cycle lengths ranged from 27 to 29 days.",
        limitationLabel: "No calibrated confidence score or next-period forecast is available.",
      },
      availability: {
        status: "estimated",
        label: "Phase estimate available from recorded cycle history.",
      },
    };

    renderCyclePage();

    expect(screen.getByRole("note", { name: "Cycle tracking safety notice" })).toHaveTextContent(
      "Tracking estimates only. Do not use for birth control or diagnosis.",
    );
  });

  it("shows privacy context and direct controls for cycle data", () => {
    renderCyclePage();

    const controls = screen.getByRole("region", { name: "Cycle data controls" });
    expect(controls).toHaveTextContent("Cycle entries and notes are sensitive health data.");
    expect(screen.getByRole("link", { name: "Review cycle history" })).toHaveAttribute(
      "href",
      "#period-history",
    );
    expect(screen.getByRole("link", { name: "Export all data" })).toHaveAttribute(
      "href",
      "/settings?tab=account",
    );
    expect(screen.getByRole("link", { name: "Delete all data" })).toHaveAttribute(
      "href",
      "/settings?tab=account",
    );
  });

  it("logs a period with trimmed symptoms or context", () => {
    renderCyclePage();

    fireEvent.change(screen.getByLabelText("Period start date"), {
      target: { value: "2026-07-03" },
    });
    fireEvent.change(screen.getByLabelText("Period symptoms or context"), {
      target: { value: "  Cramps and poor sleep  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Log Period" }));

    expect(state.mutationInput).toEqual({
      startDate: "2026-07-03",
      notes: "Cramps and poor sleep",
    });
  });

  it("renders the server-provided estimate method and observed uncertainty", () => {
    state.phaseQuery.data = {
      phase: "menstrual",
      dayOfCycle: 3,
      cycleLength: 28,
      estimate: {
        phaseLabel: "Estimated Menstrual phase",
        cycleDayLabel: "Day 3 of an estimated 28-day cycle",
        dayBasisLabel: "Cycle day is counted from the latest recorded period start.",
        methodLabel: "Phase and cycle length use the average of 3 completed cycles.",
        uncertaintyLabel: "Recorded cycle lengths ranged from 27 to 29 days.",
        limitationLabel: "No calibrated confidence score or next-period forecast is available.",
      },
      availability: {
        status: "estimated",
        label: "Phase estimate available from recorded cycle history.",
      },
    };

    renderCyclePage();

    expect(screen.getByText("Estimated Menstrual phase")).toBeTruthy();
    expect(screen.getByText("Day 3 of an estimated 28-day cycle")).toBeTruthy();
    expect(
      screen.getByText("Cycle day is counted from the latest recorded period start."),
    ).toBeTruthy();
    expect(
      screen.getByText("Phase and cycle length use the average of 3 completed cycles."),
    ).toBeTruthy();
    expect(screen.getByText("Recorded cycle lengths ranged from 27 to 29 days.")).toBeTruthy();
    expect(
      screen.getByText("No calibrated confidence score or next-period forecast is available."),
    ).toBeTruthy();
  });

  it("renders the server-provided duration label", () => {
    state.historyQuery.data = [
      {
        id: "period-1",
        startDate: "2026-07-01",
        endDate: "2026-07-05",
        durationDays: 5,
        durationLabel: "5 days",
        notes: null,
      },
    ];

    renderCyclePage();

    expect(screen.getByText("5 days")).toBeTruthy();
    expect(screen.queryByText("4 days")).toBeNull();
  });

  it("renders the server explanation instead of forcing a phase for sparse history", () => {
    state.phaseQuery.data = {
      phase: null,
      dayOfCycle: null,
      cycleLength: null,
      estimate: null,
      availability: {
        status: "sparse-history",
        label:
          "Not enough recorded history for a phase estimate. At least 3 completed cycles are needed.",
      },
    };

    renderCyclePage();

    expect(
      screen.getByText(
        "Not enough recorded history for a phase estimate. At least 3 completed cycles are needed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Log a period start to begin tracking/)).toBeNull();
  });

  it("corrects dates and notes for an existing period", () => {
    state.historyQuery.data = [
      {
        id: "period-1",
        startDate: "2026-07-01",
        endDate: "2026-07-05",
        durationDays: 5,
        durationLabel: "5 days",
        notes: "Original",
      },
    ];

    renderCyclePage();

    fireEvent.click(screen.getByRole("button", { name: "Edit period starting 2026-07-01" }));
    fireEvent.change(screen.getByLabelText("Corrected period start date"), {
      target: { value: "2026-07-02" },
    });
    fireEvent.change(screen.getByLabelText("Corrected period end date"), {
      target: { value: "2026-07-06" },
    });
    fireEvent.change(screen.getByLabelText("Period notes"), {
      target: { value: "Corrected" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save period changes" }));

    expect(state.updateMutationInput).toEqual({
      id: "period-1",
      startDate: "2026-07-02",
      endDate: "2026-07-06",
      notes: "Corrected",
    });
  });

  it("requires explicit confirmation before deleting an erroneous period", () => {
    state.historyQuery.data = [
      {
        id: "period-1",
        startDate: "2026-07-01",
        endDate: null,
        durationDays: null,
        durationLabel: null,
        notes: null,
      },
    ];

    renderCyclePage();

    fireEvent.click(screen.getByRole("button", { name: "Delete period starting 2026-07-01" }));
    expect(state.deleteMutationInput).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete period" }));

    expect(state.deleteMutationInput).toEqual({ id: "period-1" });
  });

  it("preserves corrections, offers retry, and reports a failed update", () => {
    const updateError = new Error("Period correction could not be saved.");
    state.updateMutationError = updateError;
    state.historyQuery.data = [
      {
        id: "period-1",
        startDate: "2026-07-01",
        endDate: null,
        durationDays: null,
        durationLabel: null,
        notes: null,
      },
    ];

    renderCyclePage();

    fireEvent.click(screen.getByRole("button", { name: "Edit period starting 2026-07-01" }));
    const startInput = screen.getByLabelText("Corrected period start date");
    fireEvent.change(startInput, { target: { value: "2026-07-02" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry period changes" }));

    expect(startInput).toHaveValue("2026-07-02");
    expect(screen.getByText(updateError.message)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry period changes" })).toBeTruthy();
    expect(state.captureException).toHaveBeenCalledWith(updateError, {
      context: "cycle-update-period",
    });
    expect(state.invalidateCurrentPhase).toHaveBeenCalledOnce();
    expect(state.invalidateHistory).toHaveBeenCalledOnce();
  });

  it("preserves the selected date, offers retry, and reports a failed write", () => {
    const mutationError = new Error("Period could not be saved. Please retry.");
    state.mutationError = mutationError;

    renderCyclePage();

    const dateInput = screen.getByLabelText("Period start date");
    fireEvent.change(dateInput, { target: { value: "2026-07-03" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(dateInput).toHaveValue("2026-07-03");
    expect(screen.getByText(mutationError.message)).toBeTruthy();
    expect(state.mutationInput).toEqual({ startDate: "2026-07-03", notes: null });
    expect(state.captureException).toHaveBeenCalledWith(mutationError, {
      context: "cycle-log-period",
    });
  });
});
