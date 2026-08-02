/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface MetricOption {
  id: string;
  label: string;
  unit: string;
  domain: string;
}

interface TestState {
  params: { outcomeMetricId?: string; lagDays?: string };
  listData: unknown[] | undefined;
  listLoading: boolean;
  listError: Error | null;
  metricsData: MetricOption[] | undefined;
  createInput: Record<string, unknown> | null;
  stopInput: { id: string } | null;
  analysisData: Record<string, unknown> | undefined;
  checkInInput: Record<string, unknown> | null;
  annotationInput: Record<string, unknown> | null;
}

const state = vi.hoisted<TestState>(() => ({
  params: {},
  listData: undefined,
  listLoading: false,
  listError: null,
  metricsData: [{ id: "hrv", label: "Heart Rate Variability", unit: "ms", domain: "recovery" }],
  createInput: null,
  stopInput: null,
  analysisData: undefined,
  checkInInput: null,
  annotationInput: null,
}));

vi.mock("@dofek/format/format", () => ({
  formatDateYmd: () => "2026-07-26",
}));

vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => state.params,
}));

vi.mock("../components/QueryStatePanel", () => ({
  getQueryErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : "Could not load this section.",
  QueryStatePanel: ({ variant, message }: { variant?: string; message?: string }) => (
    <div>
      {variant === "loading" ? "Loading" : null}
      {variant === "empty" ? (message ?? "Empty") : null}
      {variant === "error" ? (message ?? "Error") : null}
    </div>
  ),
}));

vi.mock("../lib/telemetry", () => ({
  captureException: vi.fn(),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      personalExperiments: {
        list: { invalidate: vi.fn() },
        analysis: { invalidate: vi.fn() },
      },
      lifeEvents: {
        list: { invalidate: vi.fn() },
      },
    }),
    personalExperiments: {
      list: {
        useQuery: () => ({
          data: state.listData,
          isLoading: state.listLoading,
          isError: Boolean(state.listError),
          error: state.listError,
        }),
      },
      metrics: {
        useQuery: () => ({
          data: state.metricsData,
          isLoading: false,
          isError: false,
          error: null,
        }),
      },
      create: {
        useMutation: (options?: { onSuccess?: () => void }) => ({
          mutate: (input: Record<string, unknown>) => {
            state.createInput = input;
            options?.onSuccess?.();
          },
          isPending: false,
          error: null,
        }),
      },
      stop: {
        useMutation: () => ({
          mutate: (input: { id: string }) => {
            state.stopInput = input;
          },
          isPending: false,
          error: null,
          variables: null,
        }),
      },
      analysis: {
        useQuery: () => ({
          data: state.analysisData,
          isLoading: false,
          isError: false,
          error: null,
        }),
      },
      checkIn: {
        useMutation: () => ({
          mutate: (input: Record<string, unknown>) => {
            state.checkInInput = input;
          },
          isPending: false,
          error: null,
        }),
      },
    },
    lifeEvents: {
      create: {
        useMutation: () => ({
          mutate: (input: Record<string, unknown>) => {
            state.annotationInput = input;
          },
          isPending: false,
          error: null,
        }),
      },
    },
  },
}));

vi.mock("../theme", () => ({
  colors: new Proxy({}, { get: () => "#71717a" }),
}));

vi.mock("./_layout-options", () => ({
  rootStackScreenOptions: {},
}));

describe("ExperimentsScreen", () => {
  beforeEach(() => {
    state.params = {};
    state.listData = [];
    state.listLoading = false;
    state.listError = null;
    state.metricsData = [
      { id: "hrv", label: "Heart Rate Variability", unit: "ms", domain: "recovery" },
    ];
    state.createInput = null;
    state.stopInput = null;
    state.analysisData = undefined;
    state.checkInInput = null;
    state.annotationInput = null;
  });

  it("shows empty state and creates an experiment", async () => {
    const ExperimentsScreen = (await import("./experiments")).default;
    render(<ExperimentsScreen />);

    expect(screen.getByText(/No experiments yet/)).toBeTruthy();

    fireEvent.change(
      screen.getByPlaceholderText("Does a consistent bedtime improve heart rate variability?"),
      { target: { value: "Does bedtime help HRV?" } },
    );
    fireEvent.change(screen.getByPlaceholderText("Lights out by 10pm on weeknights"), {
      target: { value: "Lights out by 10pm" },
    });
    fireEvent.click(screen.getByLabelText("Start experiment"));

    expect(state.createInput).toMatchObject({
      hypothesis: "Does bedtime help HRV?",
      intervention: "Lights out by 10pm",
      outcomeMetricId: "hrv",
      startDate: "2026-07-26",
    });
  });

  it("prefills outcome and lag from correlation params", async () => {
    state.params = { outcomeMetricId: "hrv", lagDays: "2" };
    const ExperimentsScreen = (await import("./experiments")).default;
    render(<ExperimentsScreen />);

    expect(screen.getByText(/prefilled from Correlation Explorer/)).toBeTruthy();
    fireEvent.change(
      screen.getByPlaceholderText("Does a consistent bedtime improve heart rate variability?"),
      { target: { value: "Hypothesis" } },
    );
    fireEvent.change(screen.getByPlaceholderText("Lights out by 10pm on weeknights"), {
      target: { value: "Intervention" },
    });
    fireEvent.click(screen.getByLabelText("Start experiment"));

    expect(state.createInput).toMatchObject({
      outcomeMetricId: "hrv",
      lagDays: 2,
    });
  });

  it("renders schedule details and stops an active experiment", async () => {
    state.listData = [
      {
        id: "exp-1",
        hypothesis: "Does bedtime help HRV?",
        intervention: "Lights out by 10pm",
        outcomeMetricId: "hrv",
        outcomeMetricLabel: "Heart Rate Variability",
        lagDays: 1,
        baselineDays: 7,
        interventionDays: 14,
        startDate: "2026-07-01",
        status: "active",
        stoppedAt: null,
        phase: "baseline",
        phaseLabel: "Baseline",
        schedule: {
          baselineStartDate: "2026-07-01",
          baselineEndDate: "2026-07-07",
          interventionStartDate: "2026-07-08",
          interventionEndDate: "2026-07-21",
          scheduleSummary: "Day 3 of baseline (5 days remaining)",
        },
      },
    ];
    const ExperimentsScreen = (await import("./experiments")).default;
    render(<ExperimentsScreen />);

    expect(screen.getByText("Day 3 of baseline (5 days remaining)")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Stop experiment"));
    expect(state.stopInput).toEqual({ id: "exp-1" });
  });

  it("records raw daily context and displays server-derived outcome evidence", async () => {
    state.listData = [
      {
        id: "exp-1",
        hypothesis: "Does bedtime help HRV?",
        intervention: "Lights out by 10pm",
        outcomeMetricId: "hrv",
        outcomeMetricLabel: "Heart Rate Variability",
        lagDays: 0,
        baselineDays: 7,
        interventionDays: 14,
        startDate: "2026-07-01",
        status: "active",
        stoppedAt: null,
        phase: "intervention",
        phaseLabel: "Intervention",
        schedule: {
          baselineStartDate: "2026-07-01",
          baselineEndDate: "2026-07-07",
          interventionStartDate: "2026-07-08",
          interventionEndDate: "2026-07-21",
          scheduleSummary: "Day 3 of intervention (12 days remaining)",
        },
      },
    ];
    state.analysisData = {
      outcomeMetricId: "hrv",
      outcomeMetricLabel: "Heart Rate Variability",
      checkIns: [],
      annotations: [
        {
          id: "event-1",
          startedAt: "2026-07-10",
          endedAt: null,
          category: null,
          ongoing: false,
          label: "Travel",
          notes: "Different time zone",
          createdAt: "2026-07-10T00:00:00.000Z",
        },
      ],
      analysis: {
        availability: "available",
        observations: [
          {
            phase: "intervention",
            phaseDate: "2026-07-10",
            outcomeDate: "2026-07-10",
            value: null,
            adherence: "partial",
            confounder: "Late flight",
            note: null,
            sourceProviderIds: [],
          },
        ],
        coverage: {
          baseline: {
            expectedDayCount: 7,
            observedOutcomeDayCount: 5,
            missingOutcomeDayCount: 2,
            checkInCount: 0,
            adherenceCounts: { adherent: 0, partial: 0, not_adherent: 0, unknown: 0 },
          },
          intervention: {
            expectedDayCount: 14,
            observedOutcomeDayCount: 12,
            missingOutcomeDayCount: 2,
            checkInCount: 5,
            adherenceCounts: { adherent: 4, partial: 1, not_adherent: 0, unknown: 0 },
          },
        },
        effect: {
          baselineMean: 50,
          interventionMean: 55,
          differenceInMeans: 5,
          baselineSampleCount: 5,
          interventionSampleCount: 5,
        },
        uncertainty: {
          availability: "available",
          method: "circular_moving_block_bootstrap",
          level: 0.95,
          lower: 1,
          upper: 8,
          requestedReplicateCount: 2000,
          attemptedReplicateCount: 2000,
          validReplicateCount: 2000,
          blockLength: 2,
        },
        limitations: ["2 outcome days are missing during baseline."],
      },
    };
    const ExperimentsScreen = (await import("./experiments")).default;
    render(<ExperimentsScreen />);

    expect(screen.getByText("Outcome evidence")).toBeTruthy();
    expect(screen.getByText("Baseline: 5 of 7 outcome days observed")).toBeTruthy();
    expect(screen.getByText("Travel: Different time zone")).toBeTruthy();
    expect(
      screen.getByText(/2026-07-10 → 2026-07-10: Missing; partial; sources: none reported/),
    ).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Partial"));
    fireEvent.change(screen.getByLabelText("Confounder"), {
      target: { value: "Late flight" },
    });
    fireEvent.click(screen.getByLabelText("Record today's check-in"));
    expect(state.checkInInput).toEqual({
      id: "exp-1",
      date: "2026-07-26",
      adherence: "partial",
      confounder: "Late flight",
      note: null,
    });

    fireEvent.change(screen.getByLabelText("Annotation label"), {
      target: { value: "Illness" },
    });
    fireEvent.click(screen.getByLabelText("Save annotation"));
    expect(state.annotationInput).toMatchObject({
      label: "Illness",
      startedAt: "2026-07-26",
      personalExperimentId: "exp-1",
    });
  });
});
