/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({ option }: { option: Record<string, unknown> }) => (
    <div data-testid="estimated-max-chart" data-option={JSON.stringify(option)} />
  ),
}));

import { EstimatedMaxChart } from "./EstimatedMaxChart.tsx";

const exercises = [
  {
    exerciseName: "Barbell Back Squat",
    history: [
      { date: "2026-05-01", estimatedMax: 118, actualWeight: 100, actualReps: 5 },
      { date: "2026-07-01", estimatedMax: 128, actualWeight: 110, actualReps: 5 },
    ],
    trend: {
      direction: "increasing" as const,
      summary: "Estimated max increased from first to latest estimate.",
      changeMagnitudeKg: 10,
      firstDate: "2026-05-01",
      latestDate: "2026-07-01",
    },
  },
  {
    exerciseName: "Single-Arm Cable Row",
    history: [
      { date: "2026-05-08", estimatedMax: 70, actualWeight: 60, actualReps: 5 },
      { date: "2026-07-08", estimatedMax: 65, actualWeight: 55, actualReps: 5 },
    ],
    trend: {
      direction: "decreasing" as const,
      summary: "Estimated max decreased from first to latest estimate.",
      changeMagnitudeKg: 5,
      firstDate: "2026-05-08",
      latestDate: "2026-07-08",
    },
  },
];

const chartOptionSchema = z.object({
  legend: z.unknown().optional(),
  series: z.array(z.object({ name: z.string() })),
  grid: z.object({ bottom: z.number() }),
  xAxis: z.object({
    axisLabel: z.object({
      hideOverlap: z.boolean(),
      showMinLabel: z.boolean(),
      showMaxLabel: z.boolean(),
    }),
  }),
});

function chartOption(): z.infer<typeof chartOptionSchema> {
  const chart = screen.getByTestId("estimated-max-chart");
  return chartOptionSchema.parse(JSON.parse(chart.dataset.option ?? "{}"));
}

describe("EstimatedMaxChart", () => {
  it("renders an accessible wrapping selector outside a single-series plot", () => {
    render(<EstimatedMaxChart exercises={exercises} />);

    const selector = screen.getByRole("group", { name: "Choose an exercise to chart" });
    expect(selector).toHaveClass("flex-wrap");

    const squatButton = screen.getByRole("button", { name: "Chart Barbell Back Squat" });
    const rowButton = screen.getByRole("button", { name: "Chart Single-Arm Cable Row" });
    expect(squatButton).toHaveAttribute("aria-pressed", "true");
    expect(rowButton).toHaveAttribute("aria-pressed", "false");

    const initialOption = chartOption();
    expect(initialOption.legend).toBeUndefined();
    expect(initialOption.series).toHaveLength(1);
    expect(initialOption.series.at(0)?.name).toBe("Barbell Back Squat");

    fireEvent.click(rowButton);

    expect(squatButton).toHaveAttribute("aria-pressed", "false");
    expect(rowButton).toHaveAttribute("aria-pressed", "true");
    expect(chartOption().series.at(0)?.name).toBe("Single-Arm Cable Row");
  });

  it("renders server-owned trend evidence and explicit selected date bounds", () => {
    render(<EstimatedMaxChart exercises={exercises} />);

    expect(
      screen.getByText("Estimated max increased from first to latest estimate."),
    ).toBeVisible();
    expect(screen.getByText("10.0 kg")).toBeVisible();
    expect(screen.getByText("May 1 – Jul 1")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Chart Single-Arm Cable Row" }));

    expect(
      screen.getByText("Estimated max decreased from first to latest estimate."),
    ).toBeVisible();
    expect(screen.getByText("5.0 kg")).toBeVisible();
    expect(screen.getByText("May 8 – Jul 8")).toBeVisible();
  });

  it("reserves space and preserves the first and last time-axis labels", () => {
    render(<EstimatedMaxChart exercises={exercises} />);

    const option = chartOption();
    expect(option.grid.bottom).toBeGreaterThanOrEqual(44);
    expect(option.xAxis.axisLabel).toMatchObject({
      hideOverlap: true,
      showMinLabel: true,
      showMaxLabel: true,
    });
  });

  it("leads with plain-language strength and keeps e1RM method details expandable", () => {
    render(<EstimatedMaxChart exercises={exercises} />);

    expect(screen.getByText("How this is calculated")).toBeVisible();
    expect(screen.getByText(/Estimated 1-Rep Max \(e1RM\)/)).not.toBeVisible();
    expect(screen.getByTestId("estimated-max-chart").dataset.option).toContain(
      "Estimated single-rep strength",
    );
  });
});
