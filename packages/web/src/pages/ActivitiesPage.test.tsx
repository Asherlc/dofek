/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockQuery {
  data: unknown[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

let mockQuery: MockQuery;
let mockOverviewQuery: {
  data:
    | {
        activityCount: number;
        totalMinutes: number;
        totalDistanceMeters: number;
        totalElevationGainM: number;
        activityTypes: string[];
      }
    | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
};
let weekListInput: unknown;
let overviewInput: unknown;
let overviewOptions: { placeholderData?: (previousData: unknown) => unknown } | undefined;
let bulkDeleteMutate: ReturnType<typeof vi.fn>;
let restoreProviderAbsentMutate: ReturnType<typeof vi.fn>;
let invalidateWeekList: ReturnType<typeof vi.fn>;
let invalidateActivityOverview: ReturnType<typeof vi.fn>;
let invalidateActivityList: ReturnType<typeof vi.fn>;

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode;
    to: string;
    params?: { id: string };
  }) => <a href={params?.id ? to.replace("$id", params.id) : to}>{children}</a>,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    calendar: {
      weekList: {
        useQuery: (input: unknown) => {
          weekListInput = input;
          return mockQuery;
        },
      },
      activityOverview: {
        useQuery: (
          input: unknown,
          options: { placeholderData?: (previousData: unknown) => unknown } | undefined,
        ) => {
          overviewInput = input;
          overviewOptions = options;
          return mockOverviewQuery;
        },
      },
    },
    activity: {
      bulkDelete: {
        useMutation: (options?: { onSuccess?: () => Promise<void> | void }) => ({
          mutate: bulkDeleteMutate.mockImplementation(async () => {
            await options?.onSuccess?.();
          }),
          isPending: false,
          error: null,
        }),
      },
      restoreProviderAbsent: {
        useMutation: (options?: { onSuccess?: () => Promise<void> | void }) => ({
          mutate: restoreProviderAbsentMutate.mockImplementation(async () => {
            await options?.onSuccess?.();
          }),
          isPending: false,
          error: null,
        }),
      },
    },
    useUtils: () => ({
      calendar: {
        weekList: { invalidate: invalidateWeekList },
        activityOverview: { invalidate: invalidateActivityOverview },
      },
      activity: {
        list: { invalidate: invalidateActivityList },
      },
    }),
  },
}));

vi.mock("../lib/unitContext.ts", () => ({
  useUnitConverter: () => ({
    formatDistance: (km: number) => ({ text: `${km.toFixed(1)} km`, parts: [] }),
    formatElevation: (meters: number) => ({ text: `${meters} m`, parts: [] }),
    convertDistance: (km: number) => km,
    distanceLabel: "km",
  }),
}));

import { ActivitiesPage } from "./ActivitiesPage.tsx";

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: "activity-1",
    name: "Trainer Ride",
    activityType: "indoor_cycling",
    startedAt: "2026-03-18T07:00:00.000Z",
    endedAt: "2026-03-18T08:00:00.000Z",
    durationMin: 60,
    location: null,
    calories: 421.6,
    tss: 100,
    stats: [
      { label: "Training Stress Score", value: "100" },
      { label: "Calories", value: "422 kcal" },
    ],
    ...overrides,
  };
}

describe("ActivitiesPage", () => {
  beforeEach(() => {
    mockQuery = { data: [], isLoading: false, isError: false, error: null };
    mockOverviewQuery = {
      data: {
        activityCount: 0,
        totalMinutes: 0,
        totalDistanceMeters: 0,
        totalElevationGainM: 0,
        activityTypes: [],
      },
      isLoading: false,
      isError: false,
      error: null,
    };
    weekListInput = undefined;
    overviewInput = undefined;
    overviewOptions = undefined;
    bulkDeleteMutate = vi.fn();
    restoreProviderAbsentMutate = vi.fn();
    invalidateWeekList = vi.fn();
    invalidateActivityOverview = vi.fn();
    invalidateActivityList = vi.fn();
  });

  it("uses QueryStatePanel for loading state", () => {
    mockQuery = { data: [], isLoading: true, isError: false, error: null };

    render(<ActivitiesPage />);

    expect(screen.getByTestId("query-state-loading")).toBeDefined();
  });

  it("uses QueryStatePanel for empty state", () => {
    render(<ActivitiesPage />);

    expect(screen.getByTestId("query-state-empty")).toBeDefined();
    expect(screen.getByText("No activities in the last 4 weeks.")).toBeDefined();
  });

  it("renders server-provided stat labels and values", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByText("Training Stress Score")).toBeDefined();
    expect(screen.getByText("100")).toBeDefined();
    expect(screen.queryByText("TSS")).toBeNull();
  });

  it("lays out each day of activities as a responsive card grid", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({ id: "activity-1", name: "Trainer Ride" }),
            activity({ id: "activity-2", name: "Morning Run", activityType: "running" }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByTestId("activity-card-grid").className).toContain("grid");
    expect(screen.getByTestId("activity-card-grid").className).toContain("lg:grid-cols-2");
  });

  it("renders server-provided overview totals", () => {
    mockOverviewQuery = {
      data: {
        activityCount: 12,
        totalMinutes: 615,
        totalDistanceMeters: 42300,
        totalElevationGainM: 520,
        activityTypes: ["running", "cycling"],
      },
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByText("12")).toBeDefined();
    expect(screen.getByText("10h 15m")).toBeDefined();
    expect(screen.getByText("42.3 km")).toBeDefined();
    expect(screen.getByText("520 m")).toBeDefined();
  });

  it("passes selected filters to the activity list query", () => {
    mockOverviewQuery = {
      data: {
        activityCount: 1,
        totalMinutes: 60,
        totalDistanceMeters: 5000,
        totalElevationGainM: 120,
        activityTypes: ["running"],
      },
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Activity type"), { target: { value: "running" } });

    expect(weekListInput).toEqual({
      weeks: 8,
      endDate: expect.any(String),
      activityType: "running",
    });
    expect(overviewInput).toEqual({
      weeks: 8,
      endDate: expect.any(String),
      activityType: "running",
    });
    const previousOverview = { activityTypes: ["running"] };
    expect(overviewOptions?.placeholderData?.(previousOverview)).toBe(previousOverview);
  });

  it("requests hidden activities when the show hidden toggle is enabled", () => {
    render(<ActivitiesPage />);
    fireEvent.click(screen.getByLabelText("Show hidden activities"));

    expect(weekListInput).toEqual({
      weeks: 4,
      endDate: expect.any(String),
      includeProviderAbsent: true,
    });
  });

  it("replaces failed map tiles with a fallback", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              location: {
                centroidLat: 37.7749,
                centroidLng: -122.4194,
                tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
                distanceMeters: 5000,
                elevationGainM: 120,
              },
            }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.error(screen.getByAltText("Activity location map"));

    expect(screen.getByText("Map unavailable")).toBeDefined();
  });

  it("allows map tile requests to include the page origin as the referrer", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              location: {
                centroidLat: 37.7749,
                centroidLng: -122.4194,
                tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
                distanceMeters: 5000,
                elevationGainM: 120,
              },
            }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByAltText("Activity location map").getAttribute("referrerpolicy")).toBe(
      "origin",
    );
  });

  it("draws a route overlay when a map tile includes route path points", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
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
            }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByTestId("activity-route-path").getAttribute("points")).toBe(
      "27.854,37.951 29.22,37.088 30.585,35.936",
    );
  });

  it("clamps map thumbnail translation to avoid blank tile edges", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              location: {
                centroidLat: 37.7749,
                centroidLng: -122.4194,
                tileUrl: "https://tile.openstreetmap.org/13/1310/3166.png",
                routePath: [
                  { x: 5, y: 5 },
                  { x: 15, y: 15 },
                ],
                distanceMeters: 5000,
                elevationGainM: 120,
              },
            }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByTestId("activity-route-viewport").getAttribute("style")).toContain(
      "translate(0%, 0%) scale(2.5)",
    );
  });

  it("centers map thumbnails around the route bounds", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
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
            }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByTestId("activity-route-viewport").getAttribute("style")).toContain(
      "translate(-25%, -37.5%) scale(2.5)",
    );
  });

  it("shows a Select button when activities are present", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByText("Select")).toBeDefined();
  });

  it("toggles selected activities instead of navigating in select mode", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByText("Select"));
    fireEvent.click(screen.getByText("Trainer Ride"));

    expect(screen.getByText("1 selected")).toBeDefined();
    expect(screen.queryByRole("link", { name: /Trainer Ride/i })).toBeNull();
  });

  it("bulk deletes selected activities after confirmation", async () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByText("Select"));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Confirm Delete"));

    await waitFor(() => {
      expect(bulkDeleteMutate).toHaveBeenCalledWith({ ids: ["activity-1"] });
      expect(invalidateWeekList).toHaveBeenCalled();
      expect(invalidateActivityOverview).toHaveBeenCalled();
      expect(invalidateActivityList).toHaveBeenCalled();
    });
  });

  it("clears selected activities when the activity type filter changes", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };
    mockOverviewQuery = {
      data: {
        activityCount: 1,
        totalMinutes: 60,
        totalDistanceMeters: 5000,
        totalElevationGainM: 120,
        activityTypes: ["running"],
      },
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByText("Select"));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.change(screen.getByLabelText("Activity type"), { target: { value: "running" } });

    expect(screen.queryByText("1 selected")).toBeNull();
    expect(screen.queryByText("Select")).not.toBeNull();
  });

  it("restores selected hidden activities after confirmation", async () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              id: "hidden-1",
              isProviderAbsent: true,
              providerId: "strava",
              providerAbsentAt: "2026-03-05T14:30:00.000Z",
              tombstoneSummary: "Removed from Strava · Mar 5, 2:30 PM",
            }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByLabelText("Show hidden activities"));
    expect(screen.getByText("Removed")).toBeDefined();
    expect(screen.getByText(/Removed from Strava/)).toBeDefined();
    fireEvent.click(screen.getByText("Select"));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.click(screen.getByText("Restore"));
    fireEvent.click(screen.getByText("Confirm Restore"));

    await waitFor(() => {
      expect(restoreProviderAbsentMutate).toHaveBeenCalledWith({ ids: ["hidden-1"] });
      expect(invalidateWeekList).toHaveBeenCalled();
      expect(invalidateActivityOverview).toHaveBeenCalled();
      expect(invalidateActivityList).toHaveBeenCalled();
    });
  });

  it("links tombstoned activities to their detail page", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              id: "hidden-1",
              isProviderAbsent: true,
              providerId: "strava",
              providerAbsentAt: "2026-03-05T14:30:00.000Z",
            }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByLabelText("Show hidden activities"));

    expect(screen.getByRole("link", { name: /Trainer Ride/i }).getAttribute("href")).toBe(
      "/activity/hidden-1",
    );
  });
});
