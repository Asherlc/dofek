// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PmcChart } from "./PmcChart.tsx";

const capturedOptions: Array<Record<string, unknown>> = [];

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({ option }: { option: Record<string, unknown> }) => {
    capturedOptions.push(option);
    return <div data-testid="training-chart" />;
  },
}));

vi.mock("./LoadingSkeleton.tsx", () => ({
  ChartLoadingSkeleton: () => <div>Loading chart</div>,
}));

vi.mock("./TrainingChartEmptyState.tsx", () => ({
  TrainingChartEmptyState: () => <div>More training data is needed</div>,
}));

type TooltipFormatter = (params: Array<{ seriesName: string; value: [string, number] }>) => string;

function isTooltipFormatter(value: unknown): value is TooltipFormatter {
  return typeof value === "function";
}

function tooltipFormatter(option: Record<string, unknown>) {
  const tooltip = option.tooltip;
  if (!tooltip || typeof tooltip !== "object") throw new Error("Tooltip configuration is missing.");
  const formatter = Reflect.get(tooltip, "formatter");
  if (!isTooltipFormatter(formatter)) throw new Error("Tooltip formatter is missing.");
  return formatter;
}

describe("PmcChart", () => {
  it("renders loading, unavailable, and empty states without constructing a chart", () => {
    const { rerender } = render(<PmcChart data={[]} loading />);
    expect(screen.getByText("Loading chart")).toBeTruthy();

    rerender(
      <PmcChart
        data={[]}
        availability={{
          status: "insufficient_data",
          sourceLabel: "Training load",
          observedCount: 2,
          minimumCount: 10,
          message: "Record more activities.",
        }}
      />,
    );
    expect(screen.getByText("More training data is needed")).toBeTruthy();

    rerender(<PmcChart data={[]} />);
    expect(screen.getByText("No training load data")).toBeTruthy();
  });

  it("renders training load, both model badges, and a safe tooltip", () => {
    capturedOptions.length = 0;
    const { rerender } = render(
      <PmcChart
        data={[
          { date: "2026-01-01", load: 0, ctl: 42, atl: 50, tsb: -8 },
          { date: "2026-01-02", load: 75, ctl: 44, atl: 55, tsb: -11 },
        ]}
        model={{ type: "learned", r2: 0.91, pairedActivities: 20, ftp: 250 }}
      />,
    );

    expect(screen.getByTestId("training-chart")).toBeTruthy();
    expect(screen.getByText(/Learned model/)).toBeTruthy();
    expect(screen.getByText("Transition")).toBeTruthy();
    expect(screen.getByText("High Risk")).toBeTruthy();

    const option = capturedOptions[0];
    if (!option) throw new Error("Expected the chart to receive an option.");
    const formatter = tooltipFormatter(option);
    expect(formatter([])).toBe("");
    expect(
      formatter([
        { seriesName: "Load", value: ["2026-01-02", 75] },
        { seriesName: "Fitness", value: ["2026-01-02", 44] },
        { seriesName: "Fatigue", value: ["2026-01-02", 55] },
        { seriesName: "Form", value: ["2026-01-02", -11] },
      ]),
    ).toContain("Load:");

    rerender(
      <PmcChart
        data={[{ date: "2026-01-03", load: 50, ctl: 45, atl: 48, tsb: -3 }]}
        model={{ type: "generic", r2: null, pairedActivities: 4, ftp: 220 }}
      />,
    );

    expect(screen.getByText(/Generic heart rate model/)).toBeTruthy();
    expect(screen.getByText(/need 10/)).toBeTruthy();
  });
});
