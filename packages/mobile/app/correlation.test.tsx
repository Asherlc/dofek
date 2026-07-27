/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted<{ correlationData: Record<string, unknown> }>(() => ({
  correlationData: {},
}));

vi.mock("@dofek/format/format", () => ({
  formatNumber: (value: number, precision = 1) => value.toFixed(precision),
  formatSigned: (value: number, precision = 1) =>
    `${value >= 0 ? "+" : ""}${value.toFixed(precision)}`,
}));

vi.mock("@dofek/scoring/colors", () => ({
  chartColors: {
    emerald: "emerald",
  },
  statusColors: {
    danger: "danger",
    positive: "positive",
    warning: "warning",
  },
  textColors: {
    neutral: "neutral",
  },
}));

vi.mock("../components/ChartTitleWithTooltip", () => ({
  ChartTitleWithTooltip: ({ title }: { title: string }) => <span>{title}</span>,
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    correlation: {
      metrics: {
        useQuery: () => ({
          data: [
            { id: "protein", label: "Protein", unit: "g", domain: "nutrition" },
            { id: "hrv", label: "Heart Rate Variability", unit: "ms", domain: "recovery" },
          ],
        }),
      },
      compute: {
        useQuery: () => ({
          data: state.correlationData,
          isLoading: false,
        }),
      },
    },
  },
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("../lib/useRefresh", () => ({
  useRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }),
}));

vi.mock("../theme", () => ({
  colors: new Proxy({}, { get: () => "#71717a" }),
}));

describe("CorrelationScreen", () => {
  beforeEach(() => {
    state.correlationData = {
      availability: "insufficient",
      dataPoints: [],
      sampleCount: 0,
      additionalSamplesRequired: 5,
      insight:
        "Insufficient data to analyze the relationship between Protein and Heart Rate Variability.",
      confidenceLevel: "insufficient",
      correlationColor: "#71717a",
    };
  });

  it("shows sample requirements without inferential statistics when data is insufficient", async () => {
    const { default: CorrelationScreen } = await import("./correlation");
    render(<CorrelationScreen />);

    expect(screen.getByText("n = 0")).toBeTruthy();
    expect(screen.getByText("5 more overlapping samples needed")).toBeTruthy();
    expect(screen.queryByText("Spearman")).toBeNull();
    expect(screen.queryByText("Pearson")).toBeNull();
    expect(screen.queryByText(/R²/)).toBeNull();
    expect(screen.queryByText(/^p =/)).toBeNull();
  });

  it("uses singular sample wording when one additional sample is required", async () => {
    state.correlationData = {
      ...state.correlationData,
      sampleCount: 4,
      additionalSamplesRequired: 1,
    };

    const { default: CorrelationScreen } = await import("./correlation");
    render(<CorrelationScreen />);

    expect(screen.getByText("1 more overlapping sample needed")).toBeTruthy();
    expect(screen.queryByText("1 more overlapping samples needed")).toBeNull();
  });

  it("preserves inferential statistics when data is available", async () => {
    state.correlationData = {
      availability: "available",
      spearmanRho: 0.75,
      spearmanPValue: 0.01,
      pearsonR: 0.7,
      pearsonPValue: 0.02,
      regression: { slope: 1, intercept: 0, rSquared: 0.49 },
      dataPoints: [],
      sampleCount: 5,
      xStats: { mean: 100, median: 100, stddev: 5, min: 90, max: 110, n: 5 },
      yStats: { mean: 50, median: 50, stddev: 3, min: 45, max: 55, n: 5 },
      insight: "Protein and Heart Rate Variability move together.",
      confidenceLevel: "early",
      correlationColor: "#34d399",
    };

    const { default: CorrelationScreen } = await import("./correlation");
    render(<CorrelationScreen />);

    expect(screen.getByText("Spearman")).toBeTruthy();
    expect(screen.getByText("Pearson")).toBeTruthy();
    expect(screen.getByText("R² = 0.490")).toBeTruthy();
    expect(screen.getByText("p = 0.010")).toBeTruthy();
  });

  it("states the selected lag in calendar days and which metric leads", async () => {
    const { default: CorrelationScreen } = await import("./correlation");
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
});
