/** @vitest-environment jsdom */

import { chartColors, operationalStatusColors } from "@dofek/scoring/colors";
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

  it("uses informational confidence styling and a direction-neutral trend line", () => {
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
      dataPoints: [
        { x: 1, y: 2, date: "2025-01" },
        { x: 2, y: 1, date: "2025-02" },
      ],
    };

    render(<CorrelationCard insight={insight} />);

    expect(screen.getByText("Strong").style.color).toBe(
      `rgb(${Number.parseInt(operationalStatusColors.info.foreground.slice(1, 3), 16)}, ${Number.parseInt(operationalStatusColors.info.foreground.slice(3, 5), 16)}, ${Number.parseInt(operationalStatusColors.info.foreground.slice(5, 7), 16)})`,
    );
    const option = JSON.parse(screen.getByTestId("correlation-chart").dataset.option ?? "{}");
    expect(option.series[1].lineStyle.color).toBe(chartColors.blue);
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
    };

    render(<CorrelationCard insight={insight} />);

    const option = JSON.parse(screen.getByTestId("correlation-chart").dataset.option ?? "{}");
    expect(option.series[0].data[1].itemStyle.color).toBe(chartColors.blue);
    expect(screen.getByText("+20%").className).toContain("text-muted");
    expect(screen.getByText("Emerging").style.color).toBe(
      `rgb(${Number.parseInt(operationalStatusColors.neutral.foreground.slice(1, 3), 16)}, ${Number.parseInt(operationalStatusColors.neutral.foreground.slice(3, 5), 16)}, ${Number.parseInt(operationalStatusColors.neutral.foreground.slice(5, 7), 16)})`,
    );
  });
});
