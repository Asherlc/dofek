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
}

const state = vi.hoisted<TestState>(() => ({
  params: {},
  listData: undefined,
  listLoading: false,
  listError: null,
  metricsData: [{ id: "hrv", label: "Heart Rate Variability", unit: "ms", domain: "recovery" }],
  createInput: null,
  stopInput: null,
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
  QueryStatePanel: ({
    variant,
    message,
  }: {
    variant?: string;
    message?: string;
  }) => (
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
});
