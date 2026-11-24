// @vitest-environment jsdom

import { UnitConverter } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/units", () => ({ useUnitConverter: () => new UnitConverter("metric") }));

import { PlannedWorkoutCard } from "./PlannedWorkoutCard";
import { samplePlannedWorkout } from "./PlannedWorkoutCard.fixtures.ts";

afterEach(cleanup);

describe("PlannedWorkoutCard (mobile)", () => {
  it("shows the authored schedule, Planned label, provider, and structured steps inside a disclosure", () => {
    render(<PlannedWorkoutCard workout={samplePlannedWorkout} />);

    expect(screen.getByText("Planned")).toBeDefined();
    expect(screen.getByText("Threshold intervals")).toBeDefined();
    expect(screen.getByText(/07:30 ·/)).toBeDefined();
    expect(screen.getByText(/Intervals\.icu/)).toBeDefined();
    expect(screen.getByText("Hold the target power.")).toBeDefined();

    expect(screen.queryByText("Power 200–240 W")).toBeNull();
    const disclosure = screen.getByRole("button", { name: "Workout steps" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(disclosure);

    expect(screen.getByText(/Repeat 3 times/)).toBeDefined();
    expect(screen.getByText(/Main set/)).toBeDefined();
    expect(screen.getByText(/^Interval/)).toBeDefined();
    expect(screen.getByText(/8m/)).toBeDefined();
    expect(screen.getByText(/Power 200–240 W/)).toBeDefined();
    expect(screen.getByText(/Heart rate 65%/)).toBeDefined();
    expect(screen.getByText(/5.0 km/)).toBeDefined();
    expect(screen.getByText(/Pace 300–330 s\/km/)).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Workout steps" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("shows a notice for unsupported steps after expanding the disclosure", () => {
    render(
      <PlannedWorkoutCard
        workout={{
          id: "partial",
          providerId: "intervals.icu",
          title: "Partial plan",
          description: null,
          sportType: "cycling",
          startTime: null,
          steps: [
            {
              kind: "step",
              text: "Warm up",
              durationSeconds: 600,
              distanceMeters: null,
              targets: [],
            },
            { kind: "unsupported" },
          ],
        }}
      />,
    );

    expect(screen.queryByText("Some steps aren't available.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Workout steps" }));
    expect(screen.getByText("Some steps aren't available.")).toBeDefined();
  });

  it("does not show the notice when every step is supported", () => {
    render(<PlannedWorkoutCard workout={samplePlannedWorkout} />);
    fireEvent.click(screen.getByRole("button", { name: "Workout steps" }));
    expect(screen.queryByText("Some steps aren't available.")).toBeNull();
  });

  it("does not repeat the sport in metadata when it is the fallback title", () => {
    render(
      <PlannedWorkoutCard
        workout={{
          id: "sport-only",
          providerId: "intervals.icu",
          title: null,
          description: null,
          sportType: "cycling",
          startTime: "07:30",
          steps: [],
        }}
      />,
    );

    expect(screen.getAllByText("Cycling")).toHaveLength(1);
    expect(screen.getByText(/07:30 · Intervals\.icu/)).toBeDefined();
  });

  it("shows Snapshot with the import date for a disconnected plan", () => {
    render(
      <PlannedWorkoutCard
        workout={{
          id: "snap-1",
          providerId: "intervals.icu",
          title: "Easy endurance",
          description: null,
          sportType: "cycling",
          startTime: null,
          steps: [],
          snapshotImportedAt: "2026-11-20T12:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByText(/Snapshot/)).toBeDefined();
    expect(screen.getByText(/Nov 20, 2026/)).toBeDefined();
  });
});
