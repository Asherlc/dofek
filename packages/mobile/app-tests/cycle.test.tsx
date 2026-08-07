// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

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

vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("@dofek/format/format", () => ({
  formatDateYmd: (date?: Date) => {
    if (!date) return "2026-07-24";
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  },
}));

vi.mock("@react-native-community/datetimepicker", () => ({
  default: ({
    accessibilityLabel,
    maximumDate,
    onChange,
    value,
  }: {
    accessibilityLabel: string;
    maximumDate?: Date;
    onChange: (event: { type: "set" }, date: Date) => void;
    value: Date;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        "data-maximum-hour": maximumDate?.getHours(),
        onClick: () =>
          onChange(
            { type: "set" },
            accessibilityLabel === "Corrected period end date"
              ? new Date(2026, 6, 6, 12)
              : new Date(2026, 6, 3, 12),
          ),
      },
      [
        value.getFullYear(),
        String(value.getMonth() + 1).padStart(2, "0"),
        String(value.getDate()).padStart(2, "0"),
      ].join("-"),
    ),
}));

vi.mock("../lib/telemetry", () => ({
  captureException: state.captureException,
}));

vi.mock("../lib/trpc", () => ({
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
          onSuccess?: () => void;
          onSettled?: () => Promise<void> | void;
        }) => ({
          mutate: (input: NonNullable<TestState["mutationInput"]>) => {
            state.mutationInput = input;
            if (state.mutationError) options.onError?.(state.mutationError);
            else options.onSuccess?.();
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

describe("CycleScreen", () => {
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
    mockPush.mockClear();
    vi.clearAllMocks();
  });

  it("renders separate loading and empty states", async () => {
    state.phaseQuery.isLoading = true;
    const { default: CycleScreen } = await import("../app/cycle");

    render(<CycleScreen />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.getByText("No periods logged yet.")).toBeTruthy();
  });

  it("shows read errors instead of valid empty states", async () => {
    state.phaseQuery.error = new Error("Current cycle data is unavailable.");
    state.historyQuery.data = undefined;
    state.historyQuery.error = new Error("Period history could not be loaded.");
    const { default: CycleScreen } = await import("../app/cycle");

    render(<CycleScreen />);

    expect(screen.getByText("Current cycle data is unavailable.")).toBeTruthy();
    expect(screen.getByText("Period history could not be loaded.")).toBeTruthy();
    expect(screen.queryByText(/No active cycle detected/)).toBeNull();
  });

  it("shows the tracking-only safety boundary beside the phase estimate", async () => {
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
    const { default: CycleScreen } = await import("../app/cycle");

    render(<CycleScreen />);

    expect(
      screen.getByLabelText(
        "Cycle tracking safety notice. Tracking estimates only. Do not use for birth control or diagnosis.",
      ),
    ).toBeTruthy();
  });

  it("shows privacy context and direct controls for cycle data", async () => {
    const { default: CycleScreen } = await import("../app/cycle");

    render(<CycleScreen />);

    expect(screen.getByText(/Cycle entries and notes are sensitive health data\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review cycle history" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Export all data" }));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/settings", params: { tab: "account" } });

    fireEvent.click(screen.getByRole("button", { name: "Delete all data" }));
    expect(mockPush).toHaveBeenLastCalledWith({
      pathname: "/settings",
      params: { tab: "account" },
    });
  });

  it("logs a period with trimmed symptoms or context", async () => {
    const { default: CycleScreen } = await import("../app/cycle");

    render(<CycleScreen />);

    fireEvent.change(screen.getByLabelText("Period symptoms or context"), {
      target: { value: "  Cramps and poor sleep  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Log Period" }));

    expect(state.mutationInput).toEqual({
      startDate: "2026-07-24",
      notes: "Cramps and poor sleep",
    });
  });

  it("clears symptoms or context after a successful period log", async () => {
    const { default: CycleScreen } = await import("../app/cycle");

    render(<CycleScreen />);

    const notesInput = screen.getByLabelText("Period symptoms or context");
    fireEvent.change(notesInput, { target: { value: "Cramps and poor sleep" } });
    fireEvent.click(screen.getByRole("button", { name: "Log Period" }));

    if (!(notesInput instanceof HTMLInputElement)) {
      throw new Error("Period symptoms or context input is not an HTML input");
    }
    expect(notesInput.value).toBe("");
  });

  it("renders the server-provided estimate method and observed uncertainty", async () => {
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
    const { default: CycleScreen } = await import("../app/cycle");

    render(<CycleScreen />);

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

  it("renders the server-provided duration label", async () => {
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
    const { default: CycleScreen } = await import("../app/cycle");

    render(<CycleScreen />);

    expect(screen.getByText("5 days")).toBeTruthy();
    expect(screen.queryByText("4 days")).toBeNull();
  });

  it("renders the server explanation instead of forcing a phase for sparse history", async () => {
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
    const { default: CycleScreen } = await import("../app/cycle");

    render(<CycleScreen />);

    expect(
      screen.getByText(
        "Not enough recorded history for a phase estimate. At least 3 completed cycles are needed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Log a period start to begin tracking/)).toBeNull();
  });

  it("corrects dates and notes for an existing period", async () => {
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
    const { default: CycleScreen } = await import("../app/cycle");

    render(<CycleScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Edit period starting 2026-07-01" }));
    fireEvent.click(screen.getByRole("button", { name: "Corrected period start date" }));
    fireEvent.click(screen.getByRole("button", { name: "Corrected period end date" }));
    fireEvent.change(screen.getByLabelText("Period notes"), {
      target: { value: "Corrected" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save period changes" }));

    expect(state.updateMutationInput).toEqual({
      id: "period-1",
      startDate: "2026-07-03",
      endDate: "2026-07-06",
      notes: "Corrected",
    });
  });

  it("normalizes period picker maximum dates to the same noon date basis", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 24, 8));
    state.historyQuery.data = [
      {
        id: "period-1",
        startDate: "2026-07-24",
        endDate: null,
        durationDays: null,
        durationLabel: null,
        notes: null,
      },
    ];
    const { default: CycleScreen } = await import("../app/cycle");

    try {
      render(<CycleScreen />);
      expect(
        screen.getByRole("button", { name: "Period start date" }).getAttribute("data-maximum-hour"),
      ).toBe("12");

      fireEvent.click(screen.getByRole("button", { name: "Edit period starting 2026-07-24" }));
      expect(
        screen
          .getByRole("button", { name: "Corrected period start date" })
          .getAttribute("data-maximum-hour"),
      ).toBe("12");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires explicit confirmation before deleting an erroneous period", async () => {
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
    const { default: CycleScreen } = await import("../app/cycle");

    render(<CycleScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Delete period starting 2026-07-01" }));
    expect(state.deleteMutationInput).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete period" }));

    expect(state.deleteMutationInput).toEqual({ id: "period-1" });
  });

  it("preserves corrections, offers retry, and reports a failed update", async () => {
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
    const { default: CycleScreen } = await import("../app/cycle");

    render(<CycleScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Edit period starting 2026-07-01" }));
    fireEvent.click(screen.getByRole("button", { name: "Corrected period start date" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry period changes" }));

    expect(screen.getByRole("button", { name: "Corrected period start date" }).textContent).toBe(
      "2026-07-03",
    );
    expect(screen.getByText(updateError.message)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry period changes" })).toBeTruthy();
    expect(state.captureException).toHaveBeenCalledWith(updateError, {
      source: "cycle-update-period",
    });
    expect(state.invalidateCurrentPhase).toHaveBeenCalledOnce();
    expect(state.invalidateHistory).toHaveBeenCalledOnce();
  });

  it("preserves the selected date, offers retry, and reports a failed write", async () => {
    const mutationError = new Error("Period could not be saved. Please retry.");
    state.mutationError = mutationError;
    const { default: CycleScreen } = await import("../app/cycle");

    render(<CycleScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Period start date" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.getByRole("button", { name: "Period start date" }).textContent).toBe(
      "2026-07-03",
    );
    expect(screen.getByText(mutationError.message)).toBeTruthy();
    expect(state.mutationInput).toEqual({ startDate: "2026-07-03", notes: null });
    expect(state.captureException).toHaveBeenCalledWith(mutationError, {
      source: "cycle-log-period",
    });
  });
});
