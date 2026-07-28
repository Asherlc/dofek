/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { chartColors } from "../lib/chartTheme.ts";

const { renderedOptions } = vi.hoisted(() => {
  function emptyOptions(): Record<string, unknown>[] {
    return [];
  }

  return { renderedOptions: emptyOptions() };
});

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({ option }: { option: Record<string, unknown> }) => {
    renderedOptions.push(option);
    return <div data-testid="monotony-chart" />;
  },
}));

import { TrainingMonotonyChart } from "./TrainingMonotonyChart.tsx";

const week = {
  week: "2026-05-11",
  monotony: 2.18,
  strain: 2_460,
  weeklyLoad: 1_128,
  dailyMeanLoad: 161.14,
  dailyLoadStandardDeviation: 73.92,
  method: {
    formula:
      "Monotony = 7-day mean daily cycling load ÷ population standard deviation of daily cycling load. Strain = weekly cycling load × monotony.",
    calendar: "Monday–Sunday calendar weeks include zero-load days.",
    activityScope: "Cycling activities with computed endurance training load.",
    interpretation:
      "These are descriptive workload-variability summaries, not an overtraining diagnosis.",
    source: {
      title: "Foster (1998), Monitoring training in athletes",
      url: "https://pubmed.ncbi.nlm.nih.gov/9662690/",
    },
  },
};

describe("TrainingMonotonyChart", () => {
  it("renders the server-provided calculation choices and primary source", () => {
    render(<TrainingMonotonyChart data={[week]} />);

    expect(screen.getByText(week.method.formula)).toBeTruthy();
    expect(screen.getByText(week.method.calendar)).toBeTruthy();
    expect(screen.getByText(week.method.interpretation)).toBeTruthy();
    expect(screen.getByRole("link", { name: week.method.source.title })).toHaveAttribute(
      "href",
      week.method.source.url,
    );
  });

  it("uses neutral styling and does not invent a high-monotony label", () => {
    render(<TrainingMonotonyChart data={[week]} />);

    const option = renderedOptions.at(-1);
    if (!option || !("series" in option) || !Array.isArray(option.series)) {
      throw new Error("Expected monotony series");
    }
    expect(option.series[0].data[0].itemStyle.color).toBe(chartColors.blue);
    if (
      !("tooltip" in option) ||
      typeof option.tooltip !== "object" ||
      option.tooltip === null ||
      !("formatter" in option.tooltip) ||
      typeof option.tooltip.formatter !== "function"
    ) {
      throw new Error("Expected tooltip formatter");
    }
    const tooltip = option.tooltip.formatter([
      {
        seriesName: "Monotony",
        value: [week.week, week.monotony],
        marker: "",
        dataIndex: 0,
      },
    ]);
    expect(tooltip).toContain("Daily mean cycling load: 161.14");
    expect(tooltip).toContain("Population standard deviation (SD): 73.92");
  });
});
