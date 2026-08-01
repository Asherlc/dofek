/** @vitest-environment jsdom */

import type { UnitSystem } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnitContext } from "../lib/unitContext.ts";
import { type Activity, ActivityList } from "./ActivityList";
import type { ActivityTableColumn } from "./ActivityTable.tsx";

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

const mapPreview = {
  width: 1024,
  height: 576,
  tiles: [
    {
      url: "https://tile.openstreetmap.org/15/5241/12665.png",
      x: 0,
      y: 0,
      width: 256,
      height: 256,
    },
  ],
  routePath: null,
};

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
      distance_state: { status: "available" },
      elevation_gain_m: 120,
      elevation_state: { status: "available" },
      location: {
        centroidLat: 37.7749,
        centroidLng: -122.4194,
        mapPreview,
      },
    },
  ];

  it("renders a list of activities with metric units", () => {
    renderWithUnits(<ActivityList activities={mockActivities} />, "metric");
    expect(screen.getByText("Morning Run")).toBeDefined();
    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.getByText("5.0 km")).toBeDefined();
  });

  it("appends activity-specific columns", () => {
    const additionalColumns: Array<ActivityTableColumn<Activity>> = [
      {
        key: "attempts",
        label: "Attempts",
        renderCell: () => 8,
      },
    ];

    renderWithUnits(
      <ActivityList activities={mockActivities} additionalColumns={additionalColumns} />,
    );

    expect(screen.getByText("Attempts")).toBeDefined();
    expect(screen.getByText("8")).toBeDefined();
  });

  it("renders distances in imperial units", () => {
    renderWithUnits(<ActivityList activities={mockActivities} />, "imperial");
    expect(screen.getByText("3.1 mi")).toBeDefined();
  });

  it("renders a compact map tile when an activity has a location summary", () => {
    renderWithUnits(<ActivityList activities={mockActivities} />);
    const image = screen.getByTestId("activity-map-preview-tile");
    expect(image.getAttribute("src")).toBe("https://tile.openstreetmap.org/15/5241/12665.png");
  });

  it("allows compact map tile requests to include the page origin as the referrer", () => {
    renderWithUnits(<ActivityList activities={mockActivities} />);
    const image = screen.getByTestId("activity-map-preview-tile");
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
              mapPreview: {
                ...mapPreview,
                routePath: [
                  { x: 278.54, y: 379.51 },
                  { x: 292.2, y: 370.88 },
                  { x: 305.85, y: 359.36 },
                ],
              },
            },
          },
        ]}
      />,
    );

    expect(screen.getByTestId("activity-route-path").getAttribute("points")).toBe(
      "278.54,379.51 292.2,370.88 305.85,359.36",
    );
  });

  it("renders a compact type icon when an activity has no location summary", () => {
    const activityWithoutLocation: Activity[] = [
      {
        id: "4",
        started_at: "2026-03-18T09:00:00Z",
        ended_at: "2026-03-18T09:45:00Z",
        activity_type: "indoor_cycling",
        name: "Trainer Ride",
        provider_id: "strava",
        source_providers: ["strava"],
        distance_meters: null,
        distance_state: { status: "missing", reason: "Distance not recorded" },
      },
    ];

    renderWithUnits(<ActivityList activities={activityWithoutLocation} />);
    expect(screen.getByTestId("activity-type-icon")).toBeDefined();
    expect(screen.getByLabelText("Indoor Cycling activity")).toBeDefined();
  });

  it("uses the exported map preview canvas for compact route thumbnails", () => {
    renderWithUnits(<ActivityList activities={mockActivities} />);

    expect(screen.getByTestId("activity-route-viewport").getAttribute("aria-label")).toBe(
      "Activity route map summary",
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

  it("explains bulk deletion and exposes the selected count as a status", () => {
    const onBulkDelete = vi.fn();
    renderWithUnits(<ActivityList activities={mockActivities} onBulkDelete={onBulkDelete} />);

    expect(screen.getByText("Choose one or more activities to delete.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    expect(screen.getByRole("status")).toHaveTextContent("0 activities selected");
    const row = screen.getByText("Morning Run").closest("tr");
    if (!row) throw new Error("Row not found");
    fireEvent.click(row);

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("1 activity selected");
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("status").getAttribute("aria-atomic")).toBe("true");
  });

  it("confirms bulk delete with selected ids", () => {
    const onBulkDelete = vi.fn();
    renderWithUnits(<ActivityList activities={mockActivities} onBulkDelete={onBulkDelete} />);

    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
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

  it("shows a scoped empty-state message when provided", () => {
    renderWithUnits(
      <ActivityList
        activities={[]}
        emptyMessage="No strength workouts in the selected 30-day range."
      />,
    );
    expect(screen.getByText("No strength workouts in the selected 30-day range.")).toBeDefined();
    expect(screen.queryByText("No recent activities")).toBeNull();
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

  it("handles activities without distance", () => {
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
        distance_state: { status: "missing", reason: "Distance not recorded" },
      },
    ];
    renderWithUnits(<ActivityList activities={activityWithoutStats} />);
    expect(screen.getByText("Distance unavailable: Distance not recorded")).toBeDefined();
  });

  it("keeps a recorded zero distance distinct from a missing distance", () => {
    const zeroDistanceActivity: Activity[] = [
      {
        id: "zero-distance",
        started_at: "2026-03-18T08:00:00Z",
        ended_at: "2026-03-18T08:30:00Z",
        activity_type: "walking",
        name: "Stationary Walk",
        provider_id: "apple",
        source_providers: ["apple"],
        distance_meters: 0,
        distance_state: { status: "available" },
      },
    ];

    renderWithUnits(<ActivityList activities={zeroDistanceActivity} />);

    expect(screen.getByText("0.0 km")).toBeDefined();
    expect(screen.queryByText("Distance not recorded")).toBeNull();
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
        distance_state: { status: "missing", reason: "Distance not recorded" },
      },
    ];

    render(<ActivityList activities={invalidTimestampActivity} />);
    expect(screen.queryByText("Invalid Date")).toBeNull();
    expect(screen.queryByText("NaNm")).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });
});
