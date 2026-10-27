/** @vitest-environment jsdom */

import { UnitConverter } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";
import { StrengthVolumeChart } from "./StrengthVolumeChart.tsx";

const chart = vi.hoisted(() => ({
  tooltip: (params: { dataIndex: number }[]): string => JSON.stringify(params),
  axisLabel: (value: number): string => String(value),
}));

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({
    option,
  }: {
    option: {
      series: { data: unknown[] }[];
      tooltip: { formatter: (params: { dataIndex: number }[]) => string };
      yAxis: { axisLabel: { formatter: (value: number) => string } };
    };
  }) => {
    chart.tooltip = option.tooltip.formatter;
    chart.axisLabel = option.yAxis.axisLabel.formatter;
    return <div data-testid="chart">{JSON.stringify(option.series[0]?.data)}</div>;
  },
}));
afterEach(cleanup);
it("switches among weight, sets and time", () => {
  render(
    <StrengthVolumeChart
      data={[
        {
          week: "2026-01-05",
          totalVolumeKg: 400,
          setCount: 5,
          workoutCount: 1,
          durationMinutes: 60,
          recordedVolumeKg: 400,
          recordedSetCount: 5,
        },
      ]}
    />,
  );
  expect(screen.getByTestId("chart").textContent).toContain("400");
  fireEvent.change(screen.getByLabelText("Strength volume metric"), { target: { value: "sets" } });
  expect(screen.getByTestId("chart").textContent).toContain(",5]");
  fireEvent.change(screen.getByLabelText("Strength volume metric"), { target: { value: "time" } });
  expect(screen.getByTestId("chart").textContent).toContain(",60]");
});
it("formats lifted weight using the selected unit system", () => {
  render(
    <UnitContext.Provider value={{ unitSystem: "imperial", setUnitSystem: () => {} }}>
      <StrengthVolumeChart
        data={[
          {
            week: "2026-01-05",
            totalVolumeKg: 400,
            setCount: 5,
            workoutCount: 1,
            durationMinutes: 60,
            recordedVolumeKg: 400,
            recordedSetCount: 5,
          },
        ]}
      />
    </UnitContext.Provider>,
  );
  expect(screen.getByTestId("chart").textContent).toContain(
    String(new UnitConverter("imperial").convertWeight(400)),
  );
});

it("shows missing measurements without plotting them and describes the selected metric", () => {
  render(
    <StrengthVolumeChart
      data={[
        {
          week: "2026-01-05",
          totalVolumeKg: 0,
          setCount: 0,
          workoutCount: 1,
          durationMinutes: null,
          recordedVolumeKg: null,
          recordedSetCount: null,
        },
        {
          week: "2026-01-12",
          totalVolumeKg: 400,
          setCount: 5,
          workoutCount: 1,
          durationMinutes: 60,
          recordedVolumeKg: 400,
          recordedSetCount: 5,
        },
      ]}
    />,
  );
  const tooltip = (index: number) => chart.tooltip([{ dataIndex: index }]);
  for (const [metric, label, value] of [
    ["weight", "Weight lifted (kg)", "400"],
    ["sets", "Sets", "5"],
    ["time", "Time (minutes)", "60"],
  ]) {
    fireEvent.change(screen.getByLabelText("Strength volume metric"), {
      target: { value: metric },
    });
    expect(screen.getByText("Weeks with incomplete records are not plotted.")).toBeVisible();
    expect(screen.getByTestId("chart").textContent).toContain('"2026-01-05",null');
    expect(tooltip(0)).toContain(`${label}: Not recorded`);
    expect(tooltip(1)).toContain(`${label}: ${value}`);
    expect(chart.tooltip([])).toBe("");
    expect(tooltip(99)).toBe("");
    expect(chart.axisLabel(500)).toBe("500");
    expect(chart.axisLabel(2000)).toBe("2.0k");
  }
});
