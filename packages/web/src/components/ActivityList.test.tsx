/** @vitest-environment jsdom */

import type { UnitSystem } from "@dofek/format/units";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maps, resetMaps } from "../lib/maplibre-test-helpers.ts";
import { UnitContext } from "../lib/unitContext.ts";
import { type Activity, ActivityList } from "./ActivityList";
import type { ActivityTableColumn } from "./ActivityTable.tsx";

vi.mock("maplibre-gl", async () => (await import("../lib/maplibre-test-helpers.ts")).maplibreMock);

beforeEach(() => {
  resetMaps();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(512);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(288);
});

async function finishMapSnapshot() {
  await waitFor(() => expect(maps.length).toBeGreaterThan(0));
  act(() => {
    for (const map of maps) map.fire("idle");
  });
}

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
  center: [-122.39868164, 37.76962919] satisfies [number, number],
  zoom: 14,
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
      canonical_type: "running",
      primary_canonical_type: null,
      name: "Morning Run",
      provider_id: "strava",
      source_providers: ["strava"],
      distance_meters: 5000,
      distance_state: { status: "available" },
      elevation_gain_m: 120,
      elevation_state: { status: "available" },
      location: {
        kind: "recorded_gps",
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

  it("uses the primary activity type for unnamed activity names and selection labels", () => {
    const firstActivity = mockActivities[0];
    if (!firstActivity) throw new Error("Expected an activity fixture");
    renderWithUnits(
      <ActivityList
        activities={[
          {
            ...firstActivity,
            name: null,
            canonical_type: "walking",
            primary_canonical_type: "running",
          },
        ]}
        onBulkDelete={() => {}}
      />,
    );

    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.getByText("Walking")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    expect(screen.getByRole("checkbox", { name: "Select Running" })).toBeDefined();
  });

  it("uses the representative type for selection when an unnamed activity has no resolved primary", () => {
    const firstActivity = mockActivities[0];
    if (!firstActivity) throw new Error("Expected an activity fixture");
    renderWithUnits(
      <ActivityList
        activities={[
          {
            ...firstActivity,
            name: null,
            canonical_type: "walking",
            primary_canonical_type: null,
          },
        ]}
        onBulkDelete={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    const selection = screen.getByRole("checkbox", { name: "Select Walking" });
    fireEvent.click(selection);

    expect(selection).toBeChecked();
    expect(mockNavigate).not.toHaveBeenCalled();
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

  it("selects concise columns and supports deletion when distance is hidden", () => {
    const onBulkDelete = vi.fn();
    renderWithUnits(
      <ActivityList activities={mockActivities} showDistance={false} onBulkDelete={onBulkDelete} />,
    );

    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Map",
      "Date",
      "Type",
      "Name",
      "Duration",
      "Provider",
      "Sources",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Morning Run" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete" }));
    expect(onBulkDelete).toHaveBeenCalledWith(["1"]);
  });

  it("renders a compact map snapshot when an activity has a location summary", async () => {
    renderWithUnits(<ActivityList activities={mockActivities} />);
    await finishMapSnapshot();
    expect(screen.getByTestId("activity-map-snapshot")).toHaveAttribute(
      "src",
      "data:image/png;base64,map",
    );
  });

  it("shows a compact processing state until the map snapshot is ready", async () => {
    const first = mockActivities[0];
    if (!first) throw new Error("Expected an activity");
    const view = renderWithUnits(
      <ActivityList activities={[{ ...first, location: { kind: "processing" } }]} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Processing map…");
    view.rerender(
      <UnitContext.Provider value={{ unitSystem: "metric", setUnitSystem: () => {} }}>
        <ActivityList activities={mockActivities} />
      </UnitContext.Provider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Processing map…");
    await finishMapSnapshot();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("draws a compact route overlay over the map snapshot", async () => {
    const mockActivity = mockActivities[0];
    if (!mockActivity) throw new Error("Missing mock activity");

    renderWithUnits(
      <ActivityList
        activities={[
          {
            ...mockActivity,
            location: {
              kind: "recorded_gps",
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

    await finishMapSnapshot();
    expect(screen.getByTestId("activity-map-snapshot")).toHaveAttribute(
      "src",
      "data:image/png;base64,map",
    );
    expect(screen.getByTestId("activity-route-path").getAttribute("d")).toBe(
      "M 278.54 379.51 C 283.093 376.633, 287.648 374.238, 292.2 370.88 C 296.752 367.522, 301.3 363.2, 305.85 359.36",
    );
  });

  it("renders a compact type icon when an activity has no location summary", () => {
    const activityWithoutLocation: Activity[] = [
      {
        id: "4",
        started_at: "2026-03-18T09:00:00Z",
        ended_at: "2026-03-18T09:45:00Z",
        canonical_type: "cycling",
        primary_canonical_type: null,
        name: "Trainer Ride",
        provider_id: "strava",
        source_providers: ["strava"],
        distance_meters: null,
        distance_state: { status: "missing", reason: "Distance not recorded" },
        elevation_gain_m: null,
        elevation_state: { status: "missing", reason: "Elevation gain not recorded" },
      },
    ];

    renderWithUnits(<ActivityList activities={activityWithoutLocation} />);
    expect(screen.getByTestId("activity-type-icon")).toBeDefined();
    expect(screen.getByLabelText("Cycling activity")).toBeDefined();
  });

  it("uses the exported map preview canvas for compact route thumbnails", () => {
    renderWithUnits(<ActivityList activities={mockActivities} />);

    expect(screen.getByTestId("activity-route-viewport").getAttribute("aria-label")).toBe(
      "Activity route map summary",
    );
  });

  it("navigates to activity detail after the map snapshot is ready", async () => {
    renderWithUnits(<ActivityList activities={mockActivities} />);
    await finishMapSnapshot();
    expect(screen.getByTestId("activity-map-snapshot")).toBeInTheDocument();
    const row = screen.getByText("Morning Run").closest("tr");
    if (!row) throw new Error("Row not found");
    fireEvent.click(row);
    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/activity/$id",
      params: { id: "1" },
    });
  });

  it("explains bulk deletion and exposes the selected count as a status", async () => {
    const onBulkDelete = vi.fn();
    renderWithUnits(<ActivityList activities={mockActivities} onBulkDelete={onBulkDelete} />);
    await finishMapSnapshot();

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
        canonical_type: "walking",
        primary_canonical_type: null,
        name: "Morning Walk",
        provider_id: "apple",
        source_providers: ["apple"],
        distance_meters: null,
        distance_state: { status: "missing", reason: "Distance not recorded" },
        elevation_gain_m: null,
        elevation_state: { status: "missing", reason: "Elevation gain not recorded" },
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
        canonical_type: "walking",
        primary_canonical_type: null,
        name: "Stationary Walk",
        provider_id: "apple",
        source_providers: ["apple"],
        distance_meters: 0,
        distance_state: { status: "available" },
        elevation_gain_m: null,
        elevation_state: { status: "missing", reason: "Elevation gain not recorded" },
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
        canonical_type: "running",
        primary_canonical_type: null,
        name: "Bad Timestamps",
        provider_id: "strava",
        source_providers: ["strava"],
        distance_meters: null,
        distance_state: { status: "missing", reason: "Distance not recorded" },
        elevation_gain_m: null,
        elevation_state: { status: "missing", reason: "Elevation gain not recorded" },
      },
    ];

    render(<ActivityList activities={invalidTimestampActivity} />);
    expect(screen.queryByText("Invalid Date")).toBeNull();
    expect(screen.queryByText("NaNm")).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("renders incomplete activity data and supports a paginated result set", () => {
    const onPageChange = vi.fn();
    const firstActivity = mockActivities[0];
    if (!firstActivity) throw new Error("Expected the activity fixture");
    renderWithUnits(
      <ActivityList
        activities={[
          {
            ...firstActivity,
            ended_at: null,
            name: null,
            source_providers: null,
          },
          {
            ...firstActivity,
            id: "negative-duration",
            ended_at: "2026-03-18T06:45:00Z",
            name: "Clock-skewed Run",
          },
        ]}
        totalCount={4}
        page={0}
        pageSize={2}
        onPageChange={onPageChange}
      />,
    );

    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Running")).toHaveLength(3);
    expect(screen.getByRole("navigation", { name: "activities pagination" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next activities page" }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("clears bulk selection after an asynchronous deletion succeeds", async () => {
    const onBulkDelete = vi.fn(async () => undefined);
    renderWithUnits(<ActivityList activities={mockActivities} onBulkDelete={onBulkDelete} />);

    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByText("Morning Run"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete" }));

    await waitFor(() => expect(onBulkDelete).toHaveBeenCalledWith(["1"]));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Select activities" })).toBeTruthy(),
    );
  });
});
