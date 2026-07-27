/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted<{ correlationData: Record<string, unknown> }>(() => ({
  correlationData: {},
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

vi.mock("../components/CorrelationStrengthBar.tsx", () => ({
  CorrelationStrengthBar: ({ rho }: { rho: number }) => <div>Correlation: {rho}</div>,
}));

vi.mock("../components/DofekChart.tsx", () => ({
  ChartRangeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  DofekChart: () => <div data-testid="scatter-plot" />,
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock("../components/QueryStatePanel.tsx", () => ({
  QueryStatePanel: () => null,
}));

vi.mock("../components/TimeRangeSelector.tsx", () => ({
  TimeRangeSelector: () => null,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    correlation: {
      metrics: {
        useQuery: () => ({
          data: [
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
          ],
          isError: false,
        }),
      },
      compute: {
        useQuery: () => ({
          data: state.correlationData,
          isError: false,
          isLoading: false,
        }),
      },
    },
  },
}));

describe("CorrelationExplorerPage", () => {
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
    const { CorrelationExplorerPage } = await import("./CorrelationExplorerPage.tsx");
    render(<CorrelationExplorerPage />);

    expect(screen.getByText("n = 0")).toBeTruthy();
    expect(screen.getByText("5 more overlapping samples needed")).toBeTruthy();
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

    const { CorrelationExplorerPage } = await import("./CorrelationExplorerPage.tsx");
    render(<CorrelationExplorerPage />);

    expect(screen.getByText("Spearman (rank)")).toBeTruthy();
    expect(screen.getByText("Pearson (linear)")).toBeTruthy();
    expect(screen.getByText("R² = 0.490")).toBeTruthy();
    expect(screen.getByText("p = 0.010")).toBeTruthy();
  });
});
