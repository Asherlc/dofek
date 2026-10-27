/** @vitest-environment jsdom */

import { UnitConverter } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SportVolumeChart } from "./SportVolumeChart.tsx";

vi.mock("../lib/unitContext.ts", () => ({ useUnitConverter: () => new UnitConverter("metric") }));
vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    training: {
      sportVolume: {
        useQuery: (input: { sport?: string; metric: string }) => ({
          data: {
            sport: input.sport ?? "running",
            sports: ["running", "swimming", "yoga"],
            metric: input.metric,
            unit: input.metric === "distance" ? "km" : "min",
            weeks: [{ week: "2026-10-19", value: input.metric === "distance" ? null : 90 }],
          },
          isLoading: false,
          isFetching: false,
          error: null,
        }),
      },
    },
  },
}));
vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({ option }: { option: { series: { data: unknown[] }[] } }) => (
    <div data-testid="chart">{JSON.stringify(option.series[0]?.data)}</div>
  ),
}));
afterEach(cleanup);
it("switches volume measures and retains unknown distance", () => {
  render(<SportVolumeChart days={30} sport="running" />);
  expect(screen.getByTestId("chart").textContent).toContain(",90]");
  fireEvent.change(screen.getByLabelText("Volume metric"), { target: { value: "distance" } });
  expect(screen.getByTestId("chart").textContent).toContain("null");
});
it("offers recorded sports and resets the metric for a time-only sport", () => {
  render(<SportVolumeChart days={null} />);
  fireEvent.change(screen.getByLabelText("Volume metric"), { target: { value: "distance" } });
  fireEvent.change(screen.getByLabelText("Volume sport"), { target: { value: "yoga" } });
  expect(screen.getByLabelText("Volume metric")).toHaveValue("time");
  expect(screen.queryByRole("option", { name: "Distance" })).toBeNull();
});
