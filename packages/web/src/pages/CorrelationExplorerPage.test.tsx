/** @vitest-environment jsdom */

import { chartColors } from "@dofek/scoring/colors";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted<{
  correlationData: Record<string, unknown> | undefined;
  correlationError: Error | null;
  metricsData:
    | Array<{
        id: string;
        label: string;
        unit: string;
        domain: string;
        description: string;
      }>
    | undefined;
}>(() => ({
  correlationData: {},
  correlationError: null,
  metricsData: undefined,
}));

vi.mock("@dofek/format/format", () => ({
  formatNumber: (value: number, precision = 1) => value.toFixed(precision),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={typeof to === "string" ? to : "/experiments"}>{children}</a>
  ),
}));

vi.mock("../components/ChartDescriptionTooltip.tsx", () => ({
  ChartDescriptionTooltip: () => null,
}));

vi.mock("../components/DofekChart.tsx", () => ({
  ChartRangeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  DofekChart: ({ option }: { option: Record<string, unknown> }) => (
    <div data-testid="scatter-plot" data-option={JSON.stringify(option)} />
  ),
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock("../components/QueryStatePanel.tsx", () => ({
  QueryStatePanel: ({ error }: { error?: Error }) => <div>{error?.message}</div>,
}));

vi.mock("../components/TimeRangeSelector.tsx", () => ({
  TimeRangeSelector: () => null,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    correlation: {
      metrics: {
        useQuery: () => ({
          data: state.metricsData,
          isError: false,
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
    },
  },
}));

describe("CorrelationExplorerPage", () => {
  beforeEach(() => {
    state.correlationError = null;
    state.metricsData = [
      {
        id: "protein",
        label: "Protein",
        unit: "g",
        domain: "nutrition",
        description: "Protein intake",
      },
      {
        id: "hrv",
        label: "Heart Rate Variability",
        unit: "ms",
        domain: "recovery",
        description: "Heart rate variability",
      },
    ];
    state.correlationData = {
      analysisVersion: 2,
      availability: "insufficient",
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
  });

  it("prevents selecting the metric already used on the opposite axis", async () => {
    const { CorrelationExplorerPage } = await import("./CorrelationExplorerPage.tsx");
    render(<CorrelationExplorerPage />);

    const proteinOptions = screen.getAllByRole("option", { name: "Protein (g)" });
    const heartRateVariabilityOptions = screen.getAllByRole("option", {
      name: "Heart Rate Variability (ms)",
    });

    expect(proteinOptions[0]).not.toBeDisabled();
    expect(proteinOptions[1]).toBeDisabled();
    expect(heartRateVariabilityOptions[0]).toBeDisabled();
    expect(heartRateVariabilityOptions[1]).not.toBeDisabled();
  });

  it("renders the server-authored interpretation warning", async () => {
    const { CorrelationExplorerPage } = await import("./CorrelationExplorerPage.tsx");
    render(<CorrelationExplorerPage />);

    expect(
      screen.getByText(
        "Measurements often persist from one day to the next (autocorrelation) or share a time trend. Either pattern can create a strong correlation without a direct relationship, so use this result to form a hypothesis—not a conclusion.",
      ),
    ).toBeTruthy();
  });

  it("renders the specific server error when a request is rejected", async () => {
    state.correlationData = undefined;
    state.correlationError = new Error("Choose two different metrics to compare.");

    const { CorrelationExplorerPage } = await import("./CorrelationExplorerPage.tsx");
    render(<CorrelationExplorerPage />);

    expect(screen.getByText("Choose two different metrics to compare.")).toBeTruthy();
  });

  it("shows sample requirements without inferential statistics when data is insufficient", async () => {
    const { CorrelationExplorerPage } = await import("./CorrelationExplorerPage.tsx");
    render(<CorrelationExplorerPage />);

    expect(screen.getByText("n = 0")).toBeTruthy();
    expect(screen.getByText("5 more paired calendar days needed")).toBeTruthy();
    expect(screen.getByText("90 selected")).toBeTruthy();
    expect(screen.getByText("90 missing pairs")).toBeTruthy();
    expect(
      screen.getByText("95% block-bootstrap interval unavailable (fewer than five paired days)."),
    ).toBeTruthy();
    expect(screen.queryByText(/block-bootstrap interval: .* to /)).toBeNull();
    expect(screen.queryByText(/Spearman/)).toBeNull();
    expect(screen.queryByText(/Pearson/)).toBeNull();
    expect(screen.queryByText(/R²/)).toBeNull();
    expect(screen.queryByText(/^p =/)).toBeNull();
  });

  it("uses singular sample wording when one additional sample is required", async () => {
    state.correlationData = {
      ...state.correlationData,
      sampleCount: 4,
      additionalSamplesRequired: 1,
    };

    const { CorrelationExplorerPage } = await import("./CorrelationExplorerPage.tsx");
    render(<CorrelationExplorerPage />);

    expect(screen.getByText("1 more paired calendar day needed")).toBeTruthy();
    expect(screen.queryByText("1 more paired calendar days needed")).toBeNull();
  });

  it("shows coverage, dependence-aware uncertainty, and server-computed effect estimates", async () => {
    state.correlationData = {
      analysisVersion: 2,
      availability: "available",
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

    const { CorrelationExplorerPage } = await import("./CorrelationExplorerPage.tsx");
    render(<CorrelationExplorerPage />);

    expect(screen.getByText("Spearman rho = 0.75")).toBeTruthy();
    expect(screen.getByText("95% block-bootstrap interval: 0.42 to 0.86")).toBeTruthy();
    expect(screen.getByText("Slope = 1.000 ms per g")).toBeTruthy();
    expect(screen.getByText("R² = 0.490")).toBeTruthy();
    expect(screen.getByText("60 paired")).toBeTruthy();
    expect(screen.getByText("29 missing pairs")).toBeTruthy();
    expect(screen.queryByText(/Pearson/)).toBeNull();
    expect(screen.queryByText(/^p =/)).toBeNull();
    expect(screen.queryByText("Early signal")).toBeNull();
  });

  it("uses a neutral trend color without legacy confidence styling", async () => {
    state.correlationData = {
      analysisVersion: 2,
      availability: "available",
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

    const { CorrelationExplorerPage } = await import("./CorrelationExplorerPage.tsx");
    render(<CorrelationExplorerPage />);

    expect(screen.queryByText("Strong")).toBeNull();
    const option = JSON.parse(screen.getByTestId("scatter-plot").dataset.option ?? "{}");
    expect(option.series[1].lineStyle.color).toBe(chartColors.blue);
  });

  it("waits for metric metadata before rendering unit-dependent evidence", async () => {
    state.metricsData = undefined;
    state.correlationData = {
      analysisVersion: 2,
      availability: "available",
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

    const { CorrelationExplorerPage } = await import("./CorrelationExplorerPage.tsx");
    const view = render(<CorrelationExplorerPage />);

    expect(screen.getByText("Spearman rho = 0.75")).toBeTruthy();
    expect(screen.queryByText(/Slope =/)).toBeNull();
    expect(screen.queryByText(/±/)).toBeNull();
    expect(screen.queryByTestId("scatter-plot")).toBeNull();
    expect(view.container.textContent).not.toContain("undefined");
    expect(view.container.textContent).not.toContain("()");

    state.metricsData = [
      {
        id: "protein",
        label: "Protein",
        unit: "g",
        domain: "nutrition",
        description: "Protein intake",
      },
      {
        id: "hrv",
        label: "Heart Rate Variability",
        unit: "ms",
        domain: "recovery",
        description: "Heart rate variability",
      },
    ];
    view.rerender(<CorrelationExplorerPage />);

    expect(screen.getByText("Slope = 1.000 ms per g")).toBeTruthy();
    expect(screen.getByTestId("scatter-plot")).toBeTruthy();
  });

  it("states the selected lag in calendar days and which metric leads", async () => {
    const { CorrelationExplorerPage } = await import("./CorrelationExplorerPage.tsx");
    render(<CorrelationExplorerPage />);

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
});
