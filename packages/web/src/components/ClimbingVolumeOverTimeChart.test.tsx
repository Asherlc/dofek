/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ClimbingVolumeOverTimeChart } from "./ClimbingVolumeOverTimeChart.tsx";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({ option }: { option: { series: { data: unknown[] }[] } }) => (
    <div data-testid="chart">{JSON.stringify(option.series[0]?.data)}</div>
  ),
}));
afterEach(cleanup);
it("switches between attempts and time without turning unknown values into zero", () => {
  render(
    <ClimbingVolumeOverTimeChart data={[{ week: "2026-01-05", attempts: null, minutes: 60 }]} />,
  );
  expect(screen.getByTestId("chart").textContent).toContain("null");
  fireEvent.change(screen.getByLabelText("Climbing volume metric"), { target: { value: "time" } });
  expect(screen.getByTestId("chart").textContent).toContain(",60]");
});
