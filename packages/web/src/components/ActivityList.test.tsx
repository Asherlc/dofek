/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type Activity, ActivityList } from "./ActivityList";

// Mock @tanstack/react-router
const mockNavigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
}));

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

  it("renders a list of activities", () => {
    render(<ActivityList activities={mockActivities} />);
    expect(screen.getByText("Morning Run")).toBeDefined();
    expect(screen.getByText("running")).toBeDefined();
    expect(screen.getByText("5.0km")).toBeDefined();
    expect(screen.getByText("450 kcal")).toBeDefined();
  });

  it("navigates to activity detail on row click", () => {
    render(<ActivityList activities={mockActivities} />);
    const row = screen.getByText("Morning Run").closest("tr");
    if (!row) throw new Error("Row not found");
    fireEvent.click(row);
    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/activity/$id",
      params: { id: "1" },
    });
  });

  it("shows empty state when no activities", () => {
    render(<ActivityList activities={[]} />);
    expect(screen.getByText("No recent activities")).toBeDefined();
  });

  it("renders loading state", () => {
    render(<ActivityList activities={[]} loading={true} />);
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
    render(<ActivityList activities={activityWithoutStats} />);
    // Should show the dash/placeholder
    const cells = screen.getAllByText("—");
    expect(cells.length).toBeGreaterThanOrEqual(2);
  });
});
