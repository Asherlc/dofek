// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
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
  phase: "menstrual";
  dayOfCycle: number;
  cycleLength: number;
  estimate: {
    phaseLabel: string;
    cycleDayLabel: string;
    dayBasisLabel: string;
    methodLabel: string;
    uncertaintyLabel: string;
    limitationLabel: string;
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
  mutationInput: { startDate: string } | null;
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
  captureException: vi.fn(),
  invalidateCurrentPhase: vi.fn(),
  invalidateHistory: vi.fn(),
}));

vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
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
    onChange,
    value,
  }: {
    accessibilityLabel: string;
    onChange: (event: { type: "set" }, date: Date) => void;
    value: Date;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        onClick: () => onChange({ type: "set" }, new Date(2026, 6, 3, 12)),
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
        useMutation: (options: { onError?: (error: Error) => void }) => ({
          mutate: (input: { startDate: string }) => {
            state.mutationInput = input;
            if (state.mutationError) options.onError?.(state.mutationError);
          },
          isPending: false,
          error: state.mutationError,
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
    vi.clearAllMocks();
  });

  it("renders separate loading and empty states", async () => {
    state.phaseQuery.isLoading = true;
    const { default: CycleScreen } = await import("./cycle");

    render(<CycleScreen />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.getByText("No periods logged yet.")).toBeTruthy();
  });

  it("shows read errors instead of valid empty states", async () => {
    state.phaseQuery.error = new Error("Current cycle data is unavailable.");
    state.historyQuery.data = undefined;
    state.historyQuery.error = new Error("Period history could not be loaded.");
    const { default: CycleScreen } = await import("./cycle");

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
    };
    const { default: CycleScreen } = await import("./cycle");

    render(<CycleScreen />);

    expect(
      screen.getByLabelText(
        "Cycle tracking safety notice. Tracking estimates only. Do not use for birth control or diagnosis.",
      ),
    ).toBeTruthy();
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
    };
    const { default: CycleScreen } = await import("./cycle");

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

  it("plainly identifies the zero-history generic default", async () => {
    state.phaseQuery.data = {
      phase: "menstrual",
      dayOfCycle: 3,
      cycleLength: 28,
      estimate: {
        phaseLabel: "Estimated Menstrual phase",
        cycleDayLabel: "Day 3 of an estimated 28-day cycle",
        dayBasisLabel: "Cycle day is counted from the latest recorded period start.",
        methodLabel:
          "Phase and cycle length use a generic 28-day default based on 0 completed cycles; this is not a personal prediction.",
        uncertaintyLabel: "No personal cycle-length range is available yet.",
        limitationLabel: "No calibrated confidence score or next-period forecast is available.",
      },
    };
    const { default: CycleScreen } = await import("./cycle");

    render(<CycleScreen />);

    expect(
      screen.getByText(
        "Phase and cycle length use a generic 28-day default based on 0 completed cycles; this is not a personal prediction.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("No personal cycle-length range is available yet.")).toBeTruthy();
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
    const { default: CycleScreen } = await import("./cycle");

    render(<CycleScreen />);

    expect(screen.getByText("5 days")).toBeTruthy();
    expect(screen.queryByText("4 days")).toBeNull();
  });

  it("preserves the selected date, offers retry, and reports a failed write", async () => {
    const mutationError = new Error("Period could not be saved. Please retry.");
    state.mutationError = mutationError;
    const { default: CycleScreen } = await import("./cycle");

    render(<CycleScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Period start date" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.getByRole("button", { name: "Period start date" }).textContent).toBe(
      "2026-07-03",
    );
    expect(screen.getByText(mutationError.message)).toBeTruthy();
    expect(state.mutationInput).toEqual({ startDate: "2026-07-03" });
    expect(state.captureException).toHaveBeenCalledWith(mutationError, {
      source: "cycle-log-period",
    });
  });
});
