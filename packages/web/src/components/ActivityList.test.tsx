/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";
import type { UnitSystem } from "../lib/units.ts";
import { type Activity, ActivityList } from "./ActivityList";

// Mock @tanstack/react-router
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

describe("ActivityList", () => {
  const mockActivities: Activity[] = [
    {
      id: "1",
      started_at: "2026-03-18T07:00:00Z",
      ended_at: "2026-03-18T07:45:00Z",
      activity_type: "running",
      name: "Morning Run",
      provider_id: "strava",
      source_providers: ["strava"],
      distance_meters: 5000,
      calories: 450,
    },
  ];

  it("renders a list of activities with metric units", () => {
    renderWithUnits(<ActivityList activities={mockActivities} />, "metric");
    expect(screen.getByText("Morning Run")).toBeDefined();
    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.getByText("5.0 km")).toBeDefined();
    expect(screen.getByText("450 kcal")).toBeDefined();
  });

  it("renders distances in imperial units", () => {
    renderWithUnits(<ActivityList activities={mockActivities} />, "imperial");
    expect(screen.getByText("3.1 mi")).toBeDefined();
  });

  it("navigates to activity detail on row click", () => {
    renderWithUnits(<ActivityList activities={mockActivities} />);
    const row = screen.getByText("Morning Run").closest("tr");
    if (!row) throw new Error("Row not found");
    fireEvent.click(row);
    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/activity/$id",
      params: { id: "1" },
    });
  });

  it("shows empty state when no activities", () => {
    renderWithUnits(<ActivityList activities={[]} />);
    expect(screen.getByText("No recent activities")).toBeDefined();
  });

  it("renders loading state", () => {
    renderWithUnits(<ActivityList activities={[]} loading={true} />);
    // ChartLoadingSkeleton should be visible
    const skeleton = document.querySelector(".animate-pulse");
    expect(skeleton).toBeDefined();
  });

  it("handles activities without distance or calories", () => {
    const activityWithoutStats: Activity[] = [
      {
        id: "2",
        started_at: "2026-03-18T08:00:00Z",
        ended_at: "2026-03-18T08:30:00Z",
        activity_type: "walking",
        name: "Morning Walk",
        provider_id: "apple",
        source_providers: ["apple"],
        distance_meters: null,
        calories: undefined,
      },
    ];
    renderWithUnits(<ActivityList activities={activityWithoutStats} />);
    // Should show the dash/placeholder
    const cells = screen.getAllByText("—");
    expect(cells.length).toBeGreaterThanOrEqual(2);
  });

  it("uses placeholders when timestamps are invalid", () => {
    const invalidTimestampActivity: Activity[] = [
      {
        id: "3",
        started_at: "not-a-date",
        ended_at: "still-not-a-date",
        activity_type: "running",
        name: "Bad Timestamps",
        provider_id: "strava",
        source_providers: ["strava"],
        distance_meters: null,
        calories: null,
      },
    ];

    render(<ActivityList activities={invalidTimestampActivity} />);
    expect(screen.queryByText("Invalid Date")).toBeNull();
    expect(screen.queryByText("NaNm")).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
});
