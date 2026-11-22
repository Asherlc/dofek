/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CyclingDecouplingChart } from "./CyclingDecouplingChart.tsx";

vi.mock("echarts-for-react", () => ({ default: () => <div /> }));

const ride = (activityId: string) => ({
  activityId,
  name: "Endurance",
  date: "2026-03-15T12:00:00Z",
  elapsedSeconds: 3600,
  modality: null,
  percent: 4,
  method: "equal_elapsed_time_halves_power_to_heart_rate" as const,
  powerMeasurementKind: "direct" as const,
  heartRateMeasurementKind: "unknown" as const,
  firstHalf: { meanWatts: 200, meanBpm: 130, coveragePct: 99, pairedSeconds: 1782 },
  secondHalf: { meanWatts: 195, meanBpm: 135, coveragePct: 98, pairedSeconds: 1764 },
});

afterEach(cleanup);

describe("CyclingDecouplingChart", () => {
  it("shows the repeat-ride empty state", () => {
    render(<CyclingDecouplingChart data={{ workoutName: null, rides: [] }} />);
    expect(screen.getByText("No repeat rides in this date range")).toBeTruthy();
  });

  it("opens selected ride details with both paired halves and its activity link", () => {
    render(
      <CyclingDecouplingChart
        data={{ workoutName: "Endurance", rides: [ride("ride-1"), ride("ride-2")] }}
      />,
    );
    expect(screen.queryByLabelText("Selected workout")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Endurance.*4.0%.*Ride 2/ }));
    expect(screen.getByText(/200 W.*130 bpm.*99%/)).toBeTruthy();
    expect(screen.getByText(/195 W.*135 bpm.*98%/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Endurance" }).getAttribute("href")).toBe(
      "/activity/ride-2",
    );
  });
});
