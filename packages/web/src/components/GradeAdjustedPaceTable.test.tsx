/** @vitest-environment jsdom */

import type { UnitSystem } from "@dofek/format/units";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";
import { GradeAdjustedPaceTable } from "./GradeAdjustedPaceTable.tsx";

function renderWithUnits(ui: ReactNode, unitSystem: UnitSystem = "metric") {
  return render(
    <UnitContext.Provider value={{ unitSystem, setUnitSystem: () => {} }}>
      {ui}
    </UnitContext.Provider>,
  );
}

const mockData = [
  {
    date: "2026-03-15",
    activityName: "Hill Hike",
    activityType: "hiking",
    distanceKm: 10,
    durationMinutes: 120,
    averagePaceMinPerKm: 12,
    gradeAdjustedPaceMinPerKm: 10,
    elevationGainMeters: 500,
    elevationLossMeters: 400,
  },
];

describe("GradeAdjustedPaceTable", () => {
  it("renders metric distance, pace, and elevation labels", () => {
    renderWithUnits(<GradeAdjustedPaceTable data={mockData} />);
    expect(screen.getByText(/10\.0/)).toBeDefined();
    expect(screen.getAllByText(/km/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/\/km/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/500/)).toBeDefined();
    expect(screen.getAllByText(/\bm\b/).length).toBeGreaterThanOrEqual(1);
  });

  it("renders imperial distance, pace, and elevation labels", () => {
    renderWithUnits(<GradeAdjustedPaceTable data={mockData} />, "imperial");
    expect(screen.getByText(/6\.2/)).toBeDefined();
    expect(screen.getAllByText(/mi/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/\/mi/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/1640/)).toBeDefined();
    expect(screen.getAllByText(/ft/).length).toBeGreaterThanOrEqual(1);
  });

  it("shows empty state when no data", () => {
    renderWithUnits(<GradeAdjustedPaceTable data={[]} />);
    expect(screen.getByText("No hiking/walking activities found")).toBeDefined();
  });

  it("shows loading state", () => {
    renderWithUnits(<GradeAdjustedPaceTable data={[]} loading={true} />);
    expect(screen.getByText(/Loading grade-adjusted pace data/)).toBeDefined();
  });

  it("highlights GAP when it differs from actual pace by more than 15%", () => {
    const dataWithBigGap = [
      {
        date: "2026-03-15",
        activityName: "Steep Hike",
        activityType: "hiking",
        distanceKm: 5,
        durationMinutes: 90,
        averagePaceMinPerKm: 10,
        gradeAdjustedPaceMinPerKm: 7,
        elevationGainMeters: 800,
        elevationLossMeters: 200,
      },
    ];
    const { container } = renderWithUnits(<GradeAdjustedPaceTable data={dataWithBigGap} />);
    const amberCell = container.querySelector(".text-amber-400");
    expect(amberCell).not.toBeNull();
  });
});
