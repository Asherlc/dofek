// @vitest-environment jsdom

import { UnitConverter } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SportVolumeChart } from "./SportVolumeChart";

vi.mock("../lib/units", () => ({ useUnitConverter: () => new UnitConverter("metric") }));
vi.mock("../lib/telemetry", () => ({ captureException: vi.fn() }));
vi.mock("../lib/trpc", () => ({
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
afterEach(cleanup);
it("offers sport-specific metrics and leaves missing distance unknown", () => {
  render(<SportVolumeChart days={30} enabled />);
  expect(screen.getByText("h:mm per week")).toBeTruthy();
  expect(screen.getByLabelText("2026-10-19: 1:30 h:mm")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Distance" }));
  expect(screen.getByLabelText("2026-10-19: Not recorded")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Yoga" }));
  expect(screen.getByLabelText("2026-10-19: 1:30 h:mm")).toBeTruthy();
  expect(screen.queryByRole("radio", { name: "Distance" })).toBeNull();
});
