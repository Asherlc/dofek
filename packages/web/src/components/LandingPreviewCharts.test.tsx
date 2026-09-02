// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LandingPreviewLineChart, LandingPreviewScatterPlot } from "./LandingPreviewCharts.tsx";

afterEach(cleanup);

describe("LandingPreviewCharts", () => {
  it("labels the scatter plot, axes, and endpoint ticks", () => {
    render(
      <LandingPreviewScatterPlot
        accessibleName="Example correlation chart"
        xAxisLabel="Sleep consistency (%)"
        xTickLabels={["70", "100"]}
        yAxisLabel="Heart rate variability (ms)"
        yTickLabels={["45", "85"]}
      />,
    );

    expect(screen.getByRole("img", { name: "Example correlation chart" })).toBeTruthy();
    expect(screen.getByText("Sleep consistency (%)")).toBeTruthy();
    expect(screen.getByText("Heart rate variability (ms)")).toBeTruthy();
    expect(screen.getByText("70")).toBeTruthy();
    expect(screen.getByText("100")).toBeTruthy();
    expect(screen.getByText("45")).toBeTruthy();
    expect(screen.getByText("85")).toBeTruthy();
  });

  it("labels the trend, value axis, and time endpoints", () => {
    render(
      <LandingPreviewLineChart
        accessibleName="Example resting heart rate trend"
        color="red"
        endLabel="May 27"
        startLabel="May 21"
        yAxisLabel="Resting heart rate (bpm)"
        yTickLabels={["48", "56"]}
      />,
    );

    expect(screen.getByRole("img", { name: "Example resting heart rate trend" })).toBeTruthy();
    expect(screen.getByText("Resting heart rate (bpm)")).toBeTruthy();
    expect(screen.getByText("48")).toBeTruthy();
    expect(screen.getByText("56")).toBeTruthy();
    expect(screen.getByText("May 21")).toBeTruthy();
    expect(screen.getByText("May 27")).toBeTruthy();
  });
});
