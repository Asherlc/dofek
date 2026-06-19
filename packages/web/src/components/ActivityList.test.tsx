/** @vitest-environment jsdom */

import type { UnitSystem } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";
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
  beforeEach(() => {
    mockNavigate.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

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
      location: {
        centroidLat: 37.7749,
        centroidLng: -122.4194,
        tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
        distanceMeters: 5000,
        elevationGainM: 120,
      },
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

  it("renders a compact map tile when an activity has a location summary", () => {
    renderWithUnits(<ActivityList activities={mockActivities} />);
    const image = screen.getByAltText("Activity route map summary");
    expect(image.getAttribute("src")).toBe("https://tile.openstreetmap.org/13/1310/3166.png");
  });

  it("allows compact map tile requests to include the page origin as the referrer", () => {
    renderWithUnits(<ActivityList activities={mockActivities} />);
    const image = screen.getByAltText("Activity route map summary");
    expect(image.getAttribute("referrerpolicy")).toBe("origin");
  });

  it("draws a compact route overlay when an activity has route path points", () => {
    const mockActivity = mockActivities[0];
    if (!mockActivity) throw new Error("Missing mock activity");

    renderWithUnits(
      <ActivityList
        activities={[
          {
            ...mockActivity,
            location: {
              centroidLat: 37.7749,
              centroidLng: -122.4194,
              tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
              routePath: [
                { x: 27.854, y: 37.951 },
                { x: 29.22, y: 37.088 },
                { x: 30.585, y: 35.936 },
              ],
              distanceMeters: 5000,
              elevationGainM: 120,
            },
          },
        ]}
      />,
    );

    expect(screen.getByTestId("activity-route-path").getAttribute("points")).toBe(
      "27.854,37.951 29.22,37.088 30.585,35.936",
    );
  });

  it("centers compact map thumbnails around the route bounds", () => {
    const mockActivity = mockActivities[0];
    if (!mockActivity) throw new Error("Missing mock activity");

    renderWithUnits(
      <ActivityList
        activities={[
          {
            ...mockActivity,
            location: {
              centroidLat: 37.7749,
              centroidLng: -122.4194,
              tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
              routePath: [
                { x: 25, y: 30 },
                { x: 35, y: 40 },
              ],
              distanceMeters: 5000,
              elevationGainM: 120,
            },
          },
        ]}
      />,
    );

    expect(screen.getByTestId("activity-route-viewport").getAttribute("style")).toContain(
      "translate(-25%, -37.5%) scale(2.5)",
    );
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

  it("toggles selected activities instead of navigating in select mode", () => {
    const onBulkDelete = vi.fn();
    renderWithUnits(<ActivityList activities={mockActivities} onBulkDelete={onBulkDelete} />);

    fireEvent.click(screen.getByText("Select"));
    const row = screen.getByText("Morning Run").closest("tr");
    if (!row) throw new Error("Row not found");
    fireEvent.click(row);

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByText("1 selected")).toBeDefined();
  });

  it("confirms bulk delete with selected ids", () => {
    const onBulkDelete = vi.fn();
    renderWithUnits(<ActivityList activities={mockActivities} onBulkDelete={onBulkDelete} />);

    fireEvent.click(screen.getByText("Select"));
    fireEvent.click(screen.getByText("Morning Run"));
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Confirm Delete"));

    expect(onBulkDelete).toHaveBeenCalledWith(["1"]);
  });

  it("shows bulk delete errors from the server", () => {
    renderWithUnits(
      <ActivityList
        activities={mockActivities}
        onBulkDelete={vi.fn()}
        bulkDeleteError="Cannot delete activity."
      />,
    );

    expect(screen.getByText("Cannot delete activity.")).toBeDefined();
  });

  it("shows empty state when no activities", () => {
    renderWithUnits(<ActivityList activities={[]} />);
    expect(screen.getByText("No recent activities")).toBeDefined();
  });

  it("shows error message when error prop is set", () => {
    renderWithUnits(<ActivityList activities={[]} error="Failed to load activities." />);
    expect(screen.getByText("Failed to load activities.")).toBeDefined();
    expect(screen.queryByText("No recent activities")).toBeNull();
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
