/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface MetricOption {
  id: string;
  label: string;
  unit: string;
  domain: string;
}

interface TestState {
  search: { outcomeMetricId?: string; lagDays?: number };
  listData: unknown[] | undefined;
  listLoading: boolean;
  listError: Error | null;
  metricsData: MetricOption[] | undefined;
  metricsLoading: boolean;
  metricsError: Error | null;
  createInput: Record<string, unknown> | null;
  stopInput: { id: string } | null;
  checkInInput: Record<string, unknown> | null;
  annotationInput: Record<string, unknown> | null;
  analysisData: Record<string, unknown> | undefined;
  createError: Error | null;
}

const state = vi.hoisted<TestState>(() => ({
  search: {},
  listData: undefined,
  listLoading: false,
  listError: null,
  metricsData: [
    { id: "hrv", label: "Heart Rate Variability", unit: "ms", domain: "recovery" },
    { id: "protein", label: "Protein", unit: "g", domain: "nutrition" },
  ],
  metricsLoading: false,
  metricsError: null,
  createInput: null,
  stopInput: null,
  checkInInput: null,
  annotationInput: null,
  analysisData: undefined,
  createError: null,
}));

vi.mock("@dofek/format/format", () => ({
  formatDateYmd: () => "2026-07-26",
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children, title }: { children: ReactNode; title: string }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

vi.mock("../components/QueryStatePanel.tsx", () => ({
  QueryStatePanel: ({
    variant,
    message,
    error,
  }: {
    variant?: string;
    message?: string;
    error?: { message: string } | null;
  }) => (
    <div>
      {variant === "loading" ? "Loading" : null}
      {variant === "empty" ? (message ?? "Empty") : null}
      {error ? error.message : null}
    </div>
  ),
}));

vi.mock("../lib/query-client.ts", () => ({
  locallyReportedErrorMeta: {},
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: vi.fn(),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      personalExperiments: {
        list: { invalidate: vi.fn() },
        analysis: { invalidate: vi.fn() },
      },
      lifeEvents: { list: { invalidate: vi.fn() } },
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
          isLoading: state.metricsLoading,
          isError: Boolean(state.metricsError),
          error: state.metricsError,
        }),
      },
      create: {
        useMutation: (options?: { onSuccess?: () => void; onError?: (error: Error) => void }) => ({
          mutate: (input: Record<string, unknown>) => {
            state.createInput = input;
            if (state.createError) options?.onError?.(state.createError);
            else options?.onSuccess?.();
          },
          isPending: false,
          error: state.createError,
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
      checkIn: {
        useMutation: () => ({
          mutate: (input: Record<string, unknown>) => {
            state.checkInInput = input;
          },
          isPending: false,
          error: null,
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

describe("PersonalExperimentsPage", () => {
  beforeEach(() => {
    state.search = {};
    state.listData = undefined;
    state.listLoading = false;
    state.listError = null;
    state.metricsData = [
      { id: "hrv", label: "Heart Rate Variability", unit: "ms", domain: "recovery" },
      { id: "protein", label: "Protein", unit: "g", domain: "nutrition" },
    ];
    state.metricsLoading = false;
    state.metricsError = null;
    state.createInput = null;
    state.stopInput = null;
    state.checkInInput = null;
    state.annotationInput = null;
    state.analysisData = undefined;
    state.createError = null;
  });

  it("shows loading then empty list states", async () => {
    state.listLoading = true;
    const { PersonalExperimentsPage } = await import("./PersonalExperimentsPage.tsx");
    const { rerender } = render(<PersonalExperimentsPage search={state.search} />);
    expect(screen.getByText("Loading")).toBeTruthy();

    state.listLoading = false;
    state.listData = [];
    rerender(<PersonalExperimentsPage search={state.search} />);
    expect(screen.getByText(/No experiments yet/)).toBeTruthy();
  });

  it("prefills outcome and lag from correlation search params", async () => {
    state.search = { outcomeMetricId: "protein", lagDays: 2 };
    state.listData = [];
    const { PersonalExperimentsPage } = await import("./PersonalExperimentsPage.tsx");
    render(<PersonalExperimentsPage search={state.search} />);

    expect(screen.getByText(/prefilled from Correlation Explorer/)).toBeTruthy();
    const outcomeMetric = screen.getByLabelText("Outcome metric");
    const outcomeLag = screen.getByLabelText("Outcome lag");
    expect(outcomeMetric).toHaveProperty("value", "protein");
    expect(outcomeLag).toHaveProperty("value", "2");
  });

  it("creates an experiment from the form", async () => {
    state.listData = [];
    const { PersonalExperimentsPage } = await import("./PersonalExperimentsPage.tsx");
    render(<PersonalExperimentsPage search={state.search} />);

    fireEvent.change(screen.getByLabelText("Hypothesis"), {
      target: { value: "Does earlier bedtime improve HRV?" },
    });
    fireEvent.change(screen.getByLabelText("Intervention"), {
      target: { value: "Lights out by 10pm" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start experiment" }));

    expect(state.createInput).toMatchObject({
      hypothesis: "Does earlier bedtime improve HRV?",
      intervention: "Lights out by 10pm",
      outcomeMetricId: "hrv",
      lagDays: 0,
      baselineDays: 7,
      interventionDays: 14,
      startDate: "2026-07-26",
    });
  });

  it("renders an active schedule and stops it", async () => {
    state.listData = [
      {
        id: "exp-1",
        hypothesis: "Does earlier bedtime improve HRV?",
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
    const { PersonalExperimentsPage } = await import("./PersonalExperimentsPage.tsx");
    render(<PersonalExperimentsPage search={state.search} />);

    expect(screen.getByText("Day 3 of baseline (5 days remaining)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop experiment" }));
    expect(state.stopInput).toEqual({ id: "exp-1" });
  });

  it("shows list errors from the server", async () => {
    state.listError = new Error("Database unavailable. Try again shortly.");
    const { PersonalExperimentsPage } = await import("./PersonalExperimentsPage.tsx");
    render(<PersonalExperimentsPage search={state.search} />);
    expect(screen.getByText("Database unavailable. Try again shortly.")).toBeTruthy();
  });

  it("records raw check-in context and renders server-derived evidence with linked annotations", async () => {
    state.listData = [
      {
        id: "exp-1",
        hypothesis: "Does earlier bedtime improve HRV?",
        intervention: "Lights out by 10pm",
        outcomeMetricId: "hrv",
        outcomeMetricLabel: "Heart Rate Variability",
        lagDays: 1,
        baselineDays: 5,
        interventionDays: 7,
        startDate: "2026-07-01",
        status: "active",
        stoppedAt: null,
        phase: "intervention",
        phaseLabel: "Intervention",
        schedule: {
          baselineStartDate: "2026-07-01",
          baselineEndDate: "2026-07-05",
          interventionStartDate: "2026-07-06",
          interventionEndDate: "2026-07-12",
          scheduleSummary: "Day 2 of intervention (6 days remaining)",
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
          label: "Late flight",
          startedAt: "2026-07-09",
          endedAt: null,
          category: "lifestyle",
          ongoing: false,
          notes: "Arrived after midnight",
          createdAt: "2026-07-09T10:00:00.000Z",
        },
      ],
      analysis: {
        availability: "available",
        observations: [],
        coverage: {
          baseline: {
            expectedDayCount: 5,
            observedOutcomeDayCount: 5,
            missingOutcomeDayCount: 0,
            checkInCount: 0,
            adherenceCounts: { adherent: 0, partial: 0, not_adherent: 0, unknown: 0 },
          },
          intervention: {
            expectedDayCount: 7,
            observedOutcomeDayCount: 5,
            missingOutcomeDayCount: 2,
            checkInCount: 5,
            adherenceCounts: { adherent: 3, partial: 2, not_adherent: 1, unknown: 1 },
          },
        },
        effect: {
          baselineMean: 14,
          interventionMean: 22,
          differenceInMeans: 8,
          baselineSampleCount: 5,
          interventionSampleCount: 5,
        },
        uncertainty: {
          availability: "available",
          method: "circular_moving_block_bootstrap",
          level: 0.95,
          blockLength: 3,
          requestedReplicateCount: 2000,
          attemptedReplicateCount: 2000,
          validReplicateCount: 2000,
          lower: 4,
          upper: 12,
        },
        limitations: ["This is an observational comparison, not a causal conclusion."],
      },
    };
    const { PersonalExperimentsPage } = await import("./PersonalExperimentsPage.tsx");
    render(<PersonalExperimentsPage search={state.search} />);

    expect(screen.getByText("Outcome evidence")).toBeTruthy();
    expect(screen.getByText(/5 of 7 intervention outcomes observed/)).toBeTruthy();
    expect(
      screen.getByText("This is an observational comparison, not a causal conclusion."),
    ).toBeTruthy();
    expect(screen.getByText("Late flight")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Adherence"), { target: { value: "partial" } });
    fireEvent.change(screen.getByLabelText("Confounder"), { target: { value: "Late flight" } });
    fireEvent.click(screen.getByRole("button", { name: "Record today's check-in" }));

    expect(state.checkInInput).toMatchObject({
      id: "exp-1",
      date: "2026-07-26",
      adherence: "partial",
      confounder: "Late flight",
      note: null,
    });

    fireEvent.change(screen.getByLabelText("Annotation label"), {
      target: { value: "Late flight" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));

    expect(state.annotationInput).toMatchObject({
      label: "Late flight",
      startedAt: "2026-07-26",
      personalExperimentId: "exp-1",
    });
  });
});
