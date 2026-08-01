/** @vitest-environment jsdom */

import { chartColors } from "@dofek/scoring/colors";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({ option }: { option: Record<string, unknown> }) => (
    <div data-testid="correlation-chart" data-option={JSON.stringify(option)} />
  ),
}));

import { CorrelationCard, type Insight } from "./CorrelationCard.tsx";

describe("CorrelationCard", () => {
  it("scales the scatter plot x-axis to the observed data range", () => {
    const insight: Insight = {
      id: "monthly-exercise-body-fat",
      type: "correlation",
      confidence: "emerging",
      metric: "Monthly body fat change",
      action: "Monthly exercise volume",
      message: "Monthly exercise volume is associated with monthly body fat change.",
      detail: "Spearman rho=-0.73, n=19",
      whenTrue: { mean: 0, n: 19 },
      whenFalse: { mean: 0, n: 0 },
      effectSize: -0.73,
      pValue: 0.01,
      dataPoints: [
        { x: 2_920, y: -0.1, date: "2025-01" },
        { x: 3_800, y: -0.9, date: "2025-02" },
      ],
    };

    render(<CorrelationCard insight={insight} />);

    const option = JSON.parse(screen.getByTestId("correlation-chart").dataset.option ?? "{}");
    expect(option.xAxis.scale).toBe(true);
  });

  it("renders server-authored relationship semantics without a confidence badge", () => {
    const insight: Insight = {
      id: "relationship",
      type: "correlation",
      confidence: "strong",
      metric: "Metric",
      action: "Action",
      message: "Relationship",
      detail: "Spearman rho=-0.73, n=19",
      whenTrue: { mean: 0, n: 19 },
      whenFalse: { mean: 0, n: 0 },
      effectSize: -0.73,
      pValue: 0.01,
      evidence: {
        relationship: "correlation",
        label: "Descriptive correlation",
        method: "Server correlation method.",
        interpretation: "Server interpretation: association does not establish causation.",
        limitations: "Server limitations: missing observations and confounding remain possible.",
        recommendation: "Server recommendation: this is not a prescription.",
      },
      dataPoints: [
        { x: 1, y: 2, date: "2025-01" },
        { x: 2, y: 1, date: "2025-02" },
      ],
    };

    render(<CorrelationCard insight={insight} />);

    expect(screen.getByText("Descriptive correlation")).toBeDefined();
    expect(screen.getByText("Server correlation method.")).toBeDefined();
    expect(
      screen.getByText("Server interpretation: association does not establish causation."),
    ).toBeDefined();
    expect(
      screen.getByText("Server limitations: missing observations and confounding remain possible."),
    ).toBeDefined();
    expect(screen.getByText("Server recommendation: this is not a prescription.")).toBeDefined();
    expect(screen.queryByText("Strong")).toBeNull();
    const option = JSON.parse(screen.getByTestId("correlation-chart").dataset.option ?? "{}");
    expect(option.series).toHaveLength(1);
  });

  it("uses neutral styling for an unevaluated conditional difference", () => {
    const insight: Insight = {
      id: "conditional",
      type: "conditional",
      confidence: "emerging",
      metric: "Metric",
      action: "Action",
      message: "Conditional relationship",
      detail: "n=20",
      whenTrue: { mean: 12, n: 10 },
      whenFalse: { mean: 10, n: 10 },
      effectSize: 0.2,
      pValue: 0.1,
      evidence: {
        relationship: "descriptive_association",
        label: "Descriptive association",
        method: "Server comparison method.",
        interpretation: "Server interpretation: association does not establish causation.",
        limitations: "Server limitations: missing observations and confounding remain possible.",
        recommendation: "Server recommendation: this is not a prescription.",
        estimateLabel: "Server estimate label.",
      },
    };

    render(<CorrelationCard insight={insight} />);

    const option = JSON.parse(screen.getByTestId("correlation-chart").dataset.option ?? "{}");
    expect(option.series[0].data[1].itemStyle.color).toBe(chartColors.blue);
    expect(screen.getByText("Server estimate label.")).toHaveClass("text-muted");
    expect(screen.queryByText("+20%")).toBeNull();
    expect(screen.queryByText("Emerging")).toBeNull();
  });
});
