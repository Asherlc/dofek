/** @vitest-environment jsdom */

import type { UnitSystem } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";
import { GradeAdjustedPaceTable } from "./GradeAdjustedPaceTable.tsx";

const mockNavigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
}));

function renderWithUnits(ui: ReactNode, unitSystem: UnitSystem = "metric") {
  return render(
    <UnitContext.Provider value={{ unitSystem, setUnitSystem: () => {} }}>
      {ui}
    </UnitContext.Provider>,
  );
}

const mockData = [
  {
    activityId: "hike-1",
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
  beforeEach(() => {
    mockNavigate.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("navigates to activity detail on row click", () => {
    const rowsWithIds = [
      {
        activityId: "activity-1",
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

    renderWithUnits(<GradeAdjustedPaceTable data={rowsWithIds} />);

    const row = screen.getByText("Hill Hike").closest("tr");
    if (!row) throw new Error("Row not found");

    fireEvent.click(row);
    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/activity/$id",
      params: { id: "activity-1" },
    });
  });

  it("renders metric distance, pace, and elevation labels", () => {
    renderWithUnits(<GradeAdjustedPaceTable data={mockData} />);
    expect(screen.getAllByText(/10\.0/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/km/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/\/km/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/500/).length).toBeGreaterThanOrEqual(1);
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
        activityId: "hike-2",
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
