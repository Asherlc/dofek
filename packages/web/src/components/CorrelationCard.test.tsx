/** @vitest-environment jsdom */
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
});
