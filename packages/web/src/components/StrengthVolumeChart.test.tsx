/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StrengthVolumeChart } from "./StrengthVolumeChart.tsx";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({ option }: { option: { series: { data: unknown[] }[] } }) => (
    <div data-testid="chart">{JSON.stringify(option.series[0]?.data)}</div>
  ),
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
