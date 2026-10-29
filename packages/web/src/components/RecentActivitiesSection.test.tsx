/** @vitest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maps, resetMaps } from "../lib/maplibre-test-helpers.ts";
import type { Activity } from "./ActivityList.tsx";
import { RecentActivitiesSection } from "./RecentActivitiesSection.tsx";

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

const mutate = vi.fn();
const mutateAsync = vi.fn();
type ActivityResponse = Omit<Activity, "primary_canonical_type"> & {
  primary_canonical_type?: Activity["primary_canonical_type"];
};
let items: ActivityResponse[];
let queryError: Error | null;
let queryOptions:
  | {
      refetchInterval?: (query: {
        state: { data?: { items: ActivityResponse[] } };
      }) => number | false;
    }
  | undefined;

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../lib/trainingDaysContext.ts", () => ({ useTrainingDays: () => ({ days: 30 }) }));
vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({ activity: { list: { invalidate: vi.fn() } } }),
    activity: {
      list: {
        useQuery: (_input: unknown, options: typeof queryOptions) => {
          queryOptions = options;
          return { data: { items, totalCount: items.length }, isLoading: false, error: queryError };
        },
      },
      bulkDelete: {
        useMutation: () => ({ mutate, mutateAsync, isPending: false, error: null }),
      },
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  queryError = null;
  items = [
    {
      id: "00000000-0000-0000-0000-000000000001",
      started_at: "2026-03-18T07:00:00Z",
      ended_at: "2026-03-18T07:45:00Z",
      canonical_type: "running",
      primary_canonical_type: null,
      name: "Morning run",
      provider_id: "strava",
      source_providers: ["strava"],
      distance_meters: 5000,
      distance_state: { status: "available" },
      elevation_gain_m: null,
      elevation_state: { status: "missing", reason: "Elevation not recorded" },
      location: null,
    },
  ];
});

describe("RecentActivitiesSection", () => {
  it("keeps old-server activities visible when primary type metadata is missing", () => {
    const firstActivity = items[0];
    if (!firstActivity) throw new Error("Expected an activity fixture");
    const { primary_canonical_type: _primaryActivityType, ...oldServerActivity } = firstActivity;
    items = [{ ...oldServerActivity, name: null }];

    render(<RecentActivitiesSection />);

    expect(screen.getAllByText("Running")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    expect(screen.getByRole("checkbox", { name: "Select Running" })).toBeInTheDocument();
  });

  it("preserves the primary activity type for unnamed activity titles", () => {
    const firstActivity = items[0];
    if (!firstActivity) throw new Error("Expected an activity fixture");
    items = [
      {
        ...firstActivity,
        name: null,
        canonical_type: "walking",
        primary_canonical_type: "running",
      },
    ];

    render(<RecentActivitiesSection />);

    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.getByText("Walking")).toBeDefined();
  });

  it("applies the distance-column preference", () => {
    render(<RecentActivitiesSection showDistance={false} />);
    expect(screen.queryByRole("columnheader", { name: "Distance" })).toBeNull();
    expect(screen.getByText("Morning run")).toBeInTheDocument();
  });

  it("uses mutation state instead of awaiting bulk delete", () => {
    render(<RecentActivitiesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Morning run" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Delete" }));
    expect(mutate).toHaveBeenCalledWith({ ids: ["00000000-0000-0000-0000-000000000001"] });
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("shows activity-specific columns", () => {
    render(
      <RecentActivitiesSection
        additionalColumns={[{ key: "attempts", label: "Attempts", renderCell: () => 8 }]}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "Attempts" })).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
  });

  it("waits for additional activity data", () => {
    items = [];
    render(<RecentActivitiesSection additionalDataLoading={true} />);
    expect(screen.getByTestId("chart-loading-skeleton")).toBeInTheDocument();
  });

  it("shows a scoped empty-state message", () => {
    items = [];
    render(
      <RecentActivitiesSection emptyMessage="No strength workouts in the selected 30-day range." />,
    );
    expect(
      screen.getByText("No strength workouts in the selected 30-day range."),
    ).toBeInTheDocument();
  });

  it("renders and polls pending maps from the server", () => {
    const first = items[0];
    if (!first) throw new Error("Expected an activity");
    items = [{ ...first, location: { kind: "processing" } }];
    render(<RecentActivitiesSection />);
    expect(screen.getByRole("status")).toHaveTextContent("Processing map…");
    expect(queryOptions?.refetchInterval?.({ state: { data: { items } } })).toBe(3000);
    expect(
      queryOptions?.refetchInterval?.({
        state: { data: { items: [{ ...first, location: null }] } },
      }),
    ).toBe(false);
    expect(queryOptions?.refetchInterval?.({ state: {} })).toBe(false);
  });

  it("keeps cached map snapshots visible when a background poll fails", async () => {
    const first = items[0];
    if (!first) throw new Error("Expected an activity");
    items = [
      {
        ...first,
        location: {
          kind: "recorded_gps",
          centroidLat: 37,
          centroidLng: -122,
          mapPreview: {
            width: 256,
            height: 256,
            routePath: null,
            center: [-90, 66.51326044],
            zoom: 0,
          },
        },
      },
    ];
    const view = render(<RecentActivitiesSection />);
    await finishMapSnapshot();
    const snapshot = screen.getByTestId("activity-map-snapshot");
    expect(snapshot).toHaveAttribute("src", "data:image/png;base64,map");
    queryError = new Error("Map refresh failed. Try again.");
    view.rerender(<RecentActivitiesSection />);
    expect(screen.getByText("Map refresh failed. Try again.")).toBeInTheDocument();
    expect(screen.getByTestId("activity-map-snapshot")).toBe(snapshot);
    expect(screen.queryByText("Processing map…")).toBeNull();
  });
});
