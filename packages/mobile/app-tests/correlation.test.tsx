/** @vitest-environment jsdom */

import { CORRELATION_AVAILABILITY_DESCRIPTION } from "@dofek/stats/correlation";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted<{
  correlationData: Record<string, unknown> | undefined;
  correlationError: Error | null;
  observationData: Record<string, unknown>;
  observationPages: Record<string, Record<string, unknown>>;
  observationInputs: Array<Record<string, unknown>>;
  observationError: Error | null;
  routerPush: CallableVitestMock;
  metricsData:
    | Array<{
        id: string;
        label: string;
        unit: string;
        domain: string;
        description: string;
        availabilityDescription: string;
      }>
    | undefined;
}>(() => ({
  correlationData: {},
  correlationError: null,
  observationData: {},
  observationPages: {},
  observationInputs: [],
  observationError: null,
  routerPush: vi.fn(),
  metricsData: undefined,
}));

vi.mock("@dofek/format/format", () => ({
  formatNumber: (value: number, precision = 1) => value.toFixed(precision),
  formatSigned: (value: number, precision = 1) =>
    `${value >= 0 ? "+" : ""}${value.toFixed(precision)}`,
}));

vi.mock("@dofek/scoring/colors", () => ({
  chartColors: {
    blue: "#2563eb",
  },
  textColors: {
    neutral: "#71717a",
  },
  operationalStatusColors: {
    info: {
      foreground: "#1e3a8a",
      surface: "#dbeafe",
    },
    neutral: {
      foreground: "#334155",
      surface: "#f1f5f9",
    },
  },
}));

vi.mock("../components/ChartTitleWithTooltip", () => ({
  ChartTitleWithTooltip: ({ title }: { title: string }) => <span>{title}</span>,
}));

vi.mock("../components/QueryStatePanel", () => ({
  getQueryErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : "Could not load this section.",
  QueryStatePanel: ({ message }: { message?: string }) => <span>{message}</span>,
}));

vi.mock("react-native-svg", () => ({
  default: ({ children }: { children: ReactNode }) => (
    <svg>
      <title>Test chart</title>
      {children}
    </svg>
  ),
  Circle: () => null,
  Line: ({ stroke, testID }: { stroke: string; testID?: string }) => (
    <g data-testid={testID} data-stroke={stroke} />
  ),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    correlation: {
      metrics: {
        useQuery: () => ({
          data: state.metricsData,
        }),
      },
      computeV2: {
        useQuery: () => ({
          data: state.correlationData,
          error: state.correlationError,
          isError: state.correlationError !== null,
          isLoading: false,
        }),
      },
      observations: {
        useQuery: (input: Record<string, unknown>) => {
          state.observationInputs.push(input);
          const cursor = typeof input.cursor === "string" ? input.cursor : "first";
          return {
            data: state.observationPages[cursor] ?? state.observationData,
            isLoading: false,
            isError: state.observationError !== null,
            error: state.observationError,
          };
        },
      },
    },
  },
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: state.routerPush }),
}));

vi.mock("../lib/useRefresh", () => ({
  useRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }),
}));

vi.mock("../theme", () => ({
  colors: new Proxy({}, { get: () => "#71717a" }),
}));

describe("CorrelationScreen", () => {
  beforeEach(() => {
    state.correlationError = null;
    state.metricsData = [
      {
        id: "protein",
        label: "Protein",
        unit: "g",
        domain: "nutrition",
        description: "Daily protein intake",
        availabilityDescription: "Needs a complete, resolved daily nutrition record.",
      },
      {
        id: "hrv",
        label: "Heart Rate Variability",
        unit: "ms",
        domain: "recovery",
        description: "Variation between heartbeats",
        availabilityDescription: "Needs a daily recovery measurement.",
      },
    ];
    state.correlationData = {
      analysisVersion: 2,
      availability: "insufficient",
      epistemicStatus: { kind: "unavailable", label: "Unavailable" },
      dataPoints: [],
      sampleCount: 0,
      additionalSamplesRequired: 5,
      coverage: {
        selectedDayCount: 90,
        eligiblePairDayCount: 90,
        observedXDayCount: 40,
        observedYDayCount: 35,
        pairedDayCount: 0,
        missingPairDayCount: 90,
      },
      uncertainty: {
        availability: "unavailable",
        method: "circular_moving_block_bootstrap",
        level: 0.95,
        blockLength: 5,
        requestedReplicateCount: 2_000,
        attemptedReplicateCount: 0,
        validReplicateCount: 0,
        reason: "insufficient_pairs",
      },
      insight:
        "Insufficient data to describe the relationship between Protein and Heart Rate Variability.",
      interpretationWarning:
        "Measurements often persist from one day to the next (autocorrelation) or share a time trend. Either pattern can create a strong correlation without a direct relationship, so use this result to form a hypothesis—not a conclusion.",
    };
    state.observationData = { items: [], totalCount: 0, nextCursor: null };
    state.observationPages = {};
    state.observationInputs = [];
    state.observationError = null;
    state.routerPush.mockReset();
  });

  it("prevents selecting the metric already used on the opposite axis", async () => {
    const { default: CorrelationScreen } = await import("../app/correlation");
    render(<CorrelationScreen />);

    const proteinChips = screen.getAllByLabelText("Protein (g)");
    const heartRateVariabilityChips = screen.getAllByLabelText("Heart Rate Variability (ms)");

    expect(proteinChips[0].getAttribute("aria-disabled")).not.toBe("true");
    expect(proteinChips[1].getAttribute("aria-disabled")).toBe("true");
    expect(heartRateVariabilityChips[0].getAttribute("aria-disabled")).toBe("true");
    expect(heartRateVariabilityChips[1].getAttribute("aria-disabled")).not.toBe("true");

    fireEvent.click(proteinChips[1]);
    expect(screen.queryByText("Select two different metrics to compare.")).toBeNull();
  });

  it("supports searching metrics, shows units, and explains availability before selection", async () => {
    const { default: CorrelationScreen } = await import("../app/correlation");
    render(<CorrelationScreen />);

    expect(screen.getByRole("textbox", { name: "Search X Axis metrics" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Search Y Axis metrics" })).toBeTruthy();
    expect(screen.getByText(CORRELATION_AVAILABILITY_DESCRIPTION)).toBeTruthy();
    expect(screen.getAllByLabelText("Protein (g)")).toHaveLength(2);
    expect(screen.getByText("Needs a complete, resolved daily nutrition record.")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Search X Axis metrics" }), {
      target: { value: "heart" },
    });

    expect(screen.getAllByLabelText("Heart Rate Variability (ms)")).toHaveLength(2);
    expect(screen.getAllByLabelText("Protein (g)")).toHaveLength(1);
  });

  it("renders the server-authored interpretation warning", async () => {
    const { default: CorrelationScreen } = await import("../app/correlation");
    render(<CorrelationScreen />);

    expect(
      screen.getByText(
        "Measurements often persist from one day to the next (autocorrelation) or share a time trend. Either pattern can create a strong correlation without a direct relationship, so use this result to form a hypothesis—not a conclusion.",
      ),
    ).toBeTruthy();
  });

  it("renders the specific server error when a request is rejected", async () => {
    state.correlationData = undefined;
    state.correlationError = new Error("Choose two different metrics to compare.");

    const { default: CorrelationScreen } = await import("../app/correlation");
    render(<CorrelationScreen />);

    expect(screen.getByText("Choose two different metrics to compare.")).toBeTruthy();
  });

  it("shows sample requirements without inferential statistics when data is insufficient", async () => {
    const { default: CorrelationScreen } = await import("../app/correlation");
    render(<CorrelationScreen />);

    expect(screen.getByText("n = 0")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.getByText("5 more paired calendar days needed")).toBeTruthy();
    expect(screen.getByText("90 selected")).toBeTruthy();
    expect(screen.getByText("90 missing pairs")).toBeTruthy();
    expect(
      screen.getByText("95% block-bootstrap interval unavailable (fewer than five paired days)."),
    ).toBeTruthy();
    expect(screen.queryByText(/block-bootstrap interval: .* to /)).toBeNull();
    expect(screen.queryByText("Spearman")).toBeNull();
    expect(screen.queryByText("Pearson")).toBeNull();
    expect(screen.queryByText(/R²/)).toBeNull();
    expect(screen.queryByText(/^p =/)).toBeNull();
  });

  it("renders a legacy cached result without an epistemic status", async () => {
    const legacyCorrelationData = { ...(state.correlationData ?? {}) };
    delete legacyCorrelationData.epistemicStatus;
    state.correlationData = legacyCorrelationData;

    const { default: CorrelationScreen } = await import("../app/correlation");
    render(<CorrelationScreen />);

    expect(screen.getByText("n = 0")).toBeTruthy();
    expect(screen.queryByText("Unavailable")).toBeNull();
  });

  it("uses singular sample wording when one additional sample is required", async () => {
    state.correlationData = {
      ...state.correlationData,
      sampleCount: 4,
      additionalSamplesRequired: 1,
    };

    const { default: CorrelationScreen } = await import("../app/correlation");
    render(<CorrelationScreen />);

    expect(screen.getByText("1 more paired calendar day needed")).toBeTruthy();
    expect(screen.queryByText("1 more paired calendar days needed")).toBeNull();
  });

  it("shows coverage, dependence-aware uncertainty, and server-computed effect estimates", async () => {
    state.correlationData = {
      analysisVersion: 2,
      availability: "available",
      epistemicStatus: { kind: "associated", label: "Associated" },
      spearmanRho: 0.75,
      regression: { slope: 1, intercept: 0, rSquared: 0.49 },
      dataPoints: [],
      sampleCount: 60,
      coverage: {
        selectedDayCount: 90,
        eligiblePairDayCount: 89,
        observedXDayCount: 70,
        observedYDayCount: 65,
        pairedDayCount: 60,
        missingPairDayCount: 29,
      },
      uncertainty: {
        availability: "available",
        method: "circular_moving_block_bootstrap",
        level: 0.95,
        blockLength: 5,
        requestedReplicateCount: 2_000,
        attemptedReplicateCount: 2_050,
        validReplicateCount: 2_000,
        lower: 0.42,
        upper: 0.86,
      },
      xStats: { mean: 100, median: 100, stddev: 5, min: 90, max: 110, n: 60 },
      yStats: { mean: 50, median: 50, stddev: 3, min: 45, max: 55, n: 60 },
      insight: "Protein and Heart Rate Variability move together.",
    };

    const { default: CorrelationScreen } = await import("../app/correlation");
    render(<CorrelationScreen />);

    expect(screen.getByText("Spearman rho = +0.75")).toBeTruthy();
    expect(screen.getByText("Associated")).toBeTruthy();
    expect(screen.getByText("95% block-bootstrap interval: +0.42 to +0.86")).toBeTruthy();
    expect(screen.getByText("Slope = 1.000 ms per g")).toBeTruthy();
    expect(screen.getByText("R² = 0.490")).toBeTruthy();
    expect(screen.getByText("60 paired")).toBeTruthy();
    expect(screen.getByText("29 missing pairs")).toBeTruthy();
    expect(screen.queryByText("Pearson")).toBeNull();
    expect(screen.queryByText(/^p =/)).toBeNull();
  });

  it("uses a neutral trend color without legacy confidence styling", async () => {
    state.correlationData = {
      analysisVersion: 2,
      availability: "available",
      epistemicStatus: { kind: "associated", label: "Associated" },
      spearmanRho: -0.75,
      regression: { slope: -1, intercept: 3, rSquared: 0.49 },
      dataPoints: [
        { x: 1, y: 2, date: "2025-01-01" },
        { x: 2, y: 1, date: "2025-01-02" },
      ],
      sampleCount: 5,
      coverage: {
        selectedDayCount: 5,
        eligiblePairDayCount: 5,
        observedXDayCount: 5,
        observedYDayCount: 5,
        pairedDayCount: 5,
        missingPairDayCount: 0,
      },
      uncertainty: {
        availability: "available",
        method: "circular_moving_block_bootstrap",
        level: 0.95,
        blockLength: 2,
        requestedReplicateCount: 2_000,
        attemptedReplicateCount: 2_000,
        validReplicateCount: 2_000,
        lower: -1,
        upper: -0.2,
      },
      xStats: { mean: 1.5, median: 1.5, stddev: 0.5, min: 1, max: 2, n: 5 },
      yStats: { mean: 1.5, median: 1.5, stddev: 0.5, min: 1, max: 2, n: 5 },
      insight: "The metrics move in opposite directions.",
    };

    const { default: CorrelationScreen } = await import("../app/correlation");
    render(<CorrelationScreen />);

    expect(screen.queryByText("strong")).toBeNull();
    expect(screen.getByTestId("correlation-trend-line").dataset.stroke).toBe("#2563eb");
    expect(
      screen.getByRole("image", {
        name: "Scatter plot. Scatter plot comparing Protein (g) and Heart Rate Variability (ms).",
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "View Scatter plot data" }));
    expect(screen.getByText("2025-01-01")).toBeTruthy();
    expect(screen.getByText(/Protein \(g\): 1.0/)).toBeTruthy();
    expect(screen.getByText(/Heart Rate Variability \(ms\): 2.0/)).toBeTruthy();
  });

  it("waits for metric metadata before rendering unit-dependent evidence", async () => {
    state.metricsData = undefined;
    state.correlationData = {
      analysisVersion: 2,
      availability: "available",
      epistemicStatus: { kind: "associated", label: "Associated" },
      spearmanRho: 0.75,
      regression: { slope: 1, intercept: 0, rSquared: 0.49 },
      dataPoints: [
        { x: 1, y: 2, date: "2025-01-01" },
        { x: 2, y: 3, date: "2025-01-02" },
      ],
      sampleCount: 5,
      coverage: {
        selectedDayCount: 5,
        eligiblePairDayCount: 5,
        observedXDayCount: 5,
        observedYDayCount: 5,
        pairedDayCount: 5,
        missingPairDayCount: 0,
      },
      uncertainty: {
        availability: "available",
        method: "circular_moving_block_bootstrap",
        level: 0.95,
        blockLength: 2,
        requestedReplicateCount: 2_000,
        attemptedReplicateCount: 2_000,
        validReplicateCount: 2_000,
        lower: 0.2,
        upper: 0.9,
      },
      xStats: { mean: 1.5, median: 1.5, stddev: 0.5, min: 1, max: 2, n: 5 },
      yStats: { mean: 2.5, median: 2.5, stddev: 0.5, min: 2, max: 3, n: 5 },
      insight: "The metrics move together.",
    };

    const { default: CorrelationScreen } = await import("../app/correlation");
    const view = render(<CorrelationScreen />);

    expect(screen.getByText("Spearman rho = +0.75")).toBeTruthy();
    expect(screen.queryByText(/Slope =/)).toBeNull();
    expect(screen.queryByText(/±/)).toBeNull();
    expect(screen.queryByText("Scatter Plot")).toBeNull();
    expect(view.container.textContent).not.toContain("undefined");
    expect(view.container.textContent).not.toContain("()");

    state.metricsData = [
      {
        id: "protein",
        label: "Protein",
        unit: "g",
        domain: "nutrition",
        description: "Protein intake",
        availabilityDescription: "Needs a complete, resolved daily nutrition record.",
      },
      {
        id: "hrv",
        label: "Heart Rate Variability",
        unit: "ms",
        domain: "recovery",
        description: "Heart rate variability",
        availabilityDescription: "Needs a daily recovery measurement.",
      },
    ];
    view.rerender(<CorrelationScreen />);

    expect(screen.getByText("Slope = 1.000 ms per g")).toBeTruthy();
    expect(screen.getByText("Scatter Plot")).toBeTruthy();
  });

  it("states the selected lag in calendar days and which metric leads", async () => {
    const { default: CorrelationScreen } = await import("../app/correlation");
    render(<CorrelationScreen />);

    expect(screen.getByText("Same day")).toBeTruthy();
    expect(screen.getByText("+1 calendar day")).toBeTruthy();
    expect(screen.getByText("+2 calendar days")).toBeTruthy();
    expect(
      screen.getByText("Protein vs Heart Rate Variability on the same calendar day"),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("+1 calendar day"));

    expect(
      screen.getByText("Protein today vs Heart Rate Variability 1 calendar day later"),
    ).toBeTruthy();
  });

  it("renders lagged paired values with accessible aggregate and record navigation", async () => {
    state.observationData = {
      totalCount: 1,
      nextCursor: null,
      items: [
        {
          x: {
            metricId: "protein",
            date: "2025-04-01",
            value: 120,
            contributors: [
              {
                kind: "aggregate_inputs",
                label: "Canonical daily nutrition inputs",
                providerIds: ["apple_health"],
                target: { type: "metric_family", family: "nutrition" },
              },
            ],
          },
          y: {
            metricId: "hrv",
            date: "2025-04-02",
            value: 55,
            contributors: [
              {
                kind: "record",
                label: "Morning run",
                providerIds: [],
                target: {
                  type: "activity",
                  activityId: "00000000-0000-4000-8000-000000000106",
                },
              },
            ],
          },
        },
      ],
    };

    const { default: CorrelationScreen } = await import("../app/correlation");
    render(<CorrelationScreen />);

    expect(screen.getByText("Paired Observations")).toBeTruthy();
    expect(screen.getByText("2025-04-01 → 2025-04-02")).toBeTruthy();
    expect(screen.getByText("Protein: 120 g")).toBeTruthy();
    expect(screen.getByText("Heart Rate Variability: 55 ms")).toBeTruthy();
    expect(screen.getByText("Aggregate inputs · Apple Health")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open Canonical daily nutrition inputs" }));
    expect(state.routerPush).toHaveBeenCalledWith("/food");

    fireEvent.click(screen.getByRole("button", { name: "Open Morning run" }));
    expect(state.routerPush).toHaveBeenCalledWith("/activity/00000000-0000-4000-8000-000000000106");
  });

  it("traverses cursor pages with accessible next and previous controls", async () => {
    state.observationPages = {
      first: {
        totalCount: 2,
        nextCursor: "2025-04-02",
        items: [
          {
            x: {
              metricId: "protein",
              date: "2025-04-03",
              value: 123,
              contributors: [],
            },
            y: {
              metricId: "hrv",
              date: "2025-04-03",
              value: 58,
              contributors: [],
            },
          },
        ],
      },
      "2025-04-02": {
        totalCount: 2,
        nextCursor: null,
        items: [
          {
            x: {
              metricId: "protein",
              date: "2025-04-01",
              value: 120,
              contributors: [],
            },
            y: {
              metricId: "hrv",
              date: "2025-04-01",
              value: 55,
              contributors: [],
            },
          },
        ],
      },
    };

    const { default: CorrelationScreen } = await import("../app/correlation");
    render(<CorrelationScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Next observation page" }));
    expect(screen.getByText("2025-04-01")).toBeTruthy();
    expect(state.observationInputs.some((input) => input.cursor === "2025-04-02")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Previous observation page" }));
    expect(screen.getByText("2025-04-03")).toBeTruthy();
  });

  it("surfaces the server observation error message", async () => {
    state.observationError = new Error("Paired observations are temporarily unavailable");

    const { default: CorrelationScreen } = await import("../app/correlation");
    render(<CorrelationScreen />);

    expect(screen.getByText("Paired observations are temporarily unavailable")).toBeTruthy();
  });
});
