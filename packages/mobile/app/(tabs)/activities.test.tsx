// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { Alert } from "react-native";
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
let weekListOptions: { placeholderData?: (previousData: unknown) => unknown } | undefined;
let overviewInput: unknown;
let overviewOptions: { placeholderData?: (previousData: unknown) => unknown } | undefined;
let bulkDeleteMutateAsync: ReturnType<typeof vi.fn>;
let invalidateWeekList: ReturnType<typeof vi.fn>;
let invalidateActivityOverview: ReturnType<typeof vi.fn>;
let invalidateActivityList: ReturnType<typeof vi.fn>;
let invalidateDataHealth: ReturnType<typeof vi.fn>;
let mockDataHealthQuery: {
  data: unknown;
  isLoading: boolean;
  error: Error | null;
};
let dataHealthInput: unknown;
const routerPush = vi.fn();

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock("../../lib/trpc", () => ({
  trpc: {
    calendar: {
      weekList: {
        useQuery: (
          input: unknown,
          options: { placeholderData?: (previousData: unknown) => unknown } | undefined,
        ) => {
          weekListInput = input;
          weekListOptions = options;
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
          mutate: bulkDeleteMutateAsync.mockImplementation(async () => {
            await options?.onSuccess?.();
            return { success: true, deletedCount: 1 };
          }),
          isPending: false,
          error: null,
        }),
      },
    },
    sync: {
      dataHealth: {
        useQuery: (input: unknown) => {
          dataHealthInput = input;
          return mockDataHealthQuery;
        },
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
      sync: {
        dataHealth: { invalidate: invalidateDataHealth },
      },
    }),
  },
}));

vi.mock("../../lib/units", () => ({
  useUnitConverter: () => ({
    formatDistance: (km: number) => ({ text: `${km.toFixed(1)} km`, parts: [] }),
    formatElevation: (meters: number) => ({ text: `${meters} m`, parts: [] }),
    convertDistance: (km: number) => km,
    distanceLabel: "km",
  }),
}));

vi.mock("../../lib/useRefresh", () => ({
  useRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }),
}));

vi.mock("react-native-svg", () => ({
  default: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) =>
    createElement("svg", props, children),
  Polyline: ({ testID, ...props }: Record<string, unknown>) =>
    createElement("polyline", { ...props, "data-testid": testID }),
}));

import ActivitiesScreen from "./activities";

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

describe("ActivitiesScreen", () => {
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
    bulkDeleteMutateAsync = vi.fn();
    invalidateWeekList = vi.fn();
    invalidateActivityOverview = vi.fn();
    invalidateActivityList = vi.fn();
    mockDataHealthQuery = { data: undefined, isLoading: false, error: null };
    dataHealthInput = undefined;
    invalidateDataHealth = vi.fn();
    routerPush.mockReset();
    vi.restoreAllMocks();
  });

  it("shows activity readiness when activity summaries are blocked", () => {
    mockDataHealthQuery = {
      data: {
        overallStatus: "blocked",
        generatedAt: "2026-06-30T08:00:00.000Z",
        datasets: [
          {
            key: "activity",
            label: "Activities",
            rawRows: 12,
            latestRawAt: "2026-06-30T07:00:00.000Z",
            latestReadModelAt: null,
            cdcLagSeconds: null,
            readModelLagSeconds: null,
            status: "blocked",
            message: "Activities data is available, but ClickHouse mirrors are not current.",
          },
        ],
      },
      isLoading: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    expect(dataHealthInput).toEqual({ datasets: ["activity"] });
    expect(screen.getByText("Some data is temporarily unavailable")).toBeDefined();
    expect(
      screen.getByText("Activities data is still being prepared. Please check back soon."),
    ).toBeDefined();
  });

  it("uses QueryStatePanel for overview loading state", () => {
    mockOverviewQuery = { data: undefined, isLoading: true, isError: false, error: null };

    render(<ActivitiesScreen />);

    expect(screen.getByTestId("query-state-loading")).toBeDefined();
  });

  it("renders server-provided stat labels and values", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    expect(screen.getByText("Training Stress Score")).toBeDefined();
    expect(screen.getByText("100")).toBeDefined();
    expect(screen.queryByText("TSS")).toBeNull();
  });

  it("keeps placeholder activity data visible during background refetch errors", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity({ name: "Cached Ride" })] }],
      isLoading: false,
      isError: true,
      error: new Error("Refetch failed"),
    };

    render(<ActivitiesScreen />);

    expect(screen.getByText("Cached Ride")).toBeDefined();
    expect(screen.getByText("Refetch failed")).toBeDefined();
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

    render(<ActivitiesScreen />);

    expect(screen.getByText("12")).toBeDefined();
    expect(screen.getByText("10h 15m")).toBeDefined();
    expect(screen.getByText("42.3 km")).toBeDefined();
    expect(screen.getByText("520 m")).toBeDefined();
  });

  it("passes selected activity type to the activity list query", () => {
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

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByText("Running"));

    expect(weekListInput).toEqual({
      weeks: 4,
      endDate: expect.any(String),
      activityType: "running",
    });
    expect(overviewInput).toEqual({
      weeks: 4,
      endDate: expect.any(String),
      activityType: "running",
    });
    const previousOverview = { activityTypes: ["running"] };
    expect(overviewOptions?.placeholderData?.(previousOverview)).toBe(previousOverview);
    const previousWeekList = [{ date: "2026-03-18", activities: [] }];
    expect(weekListOptions?.placeholderData?.(previousWeekList)).toBe(previousWeekList);
  });

  it("navigates to activity detail when not selecting activities", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByText("Trainer Ride"));

    expect(routerPush).toHaveBeenCalledWith("/activity/activity-1");
  });

  it("toggles selected activities instead of navigating in select mode", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByText("Select"));
    fireEvent.click(screen.getByText("Trainer Ride"));

    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.getByText("1 selected")).toBeDefined();
  });

  it("bulk deletes selected activities after confirmation", async () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };
    vi.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === "Delete")?.onPress?.();
    });

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByText("Select"));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(bulkDeleteMutateAsync).toHaveBeenCalledWith({ ids: ["activity-1"] });
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

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByText("Select"));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.click(screen.getByText("Running"));

    expect(screen.queryByText("1 selected")).toBeNull();
    expect(screen.getByText("Select")).toBeDefined();
  });

  it("clears selected activities when the date range changes", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByText("Select"));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.click(screen.getByText("8 weeks"));

    expect(screen.queryByText("1 selected")).toBeNull();
    expect(screen.getByText("Select")).toBeDefined();
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
                mapPreview: {
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
                },
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

    render(<ActivitiesScreen />);

    fireEvent.error(screen.getByTestId("activity-map-preview-tile"));

    expect(screen.getByLabelText("Activity location unavailable")).toBeDefined();
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
                mapPreview: {
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
                    {
                      url: "https://tile.openstreetmap.org/15/5242/12665.png",
                      x: 256,
                      y: 0,
                      width: 256,
                      height: 256,
                    },
                  ],
                  routePath: [
                    { x: 278.54, y: 379.51 },
                    { x: 292.2, y: 370.88 },
                    { x: 305.85, y: 359.36 },
                  ],
                },
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

    render(<ActivitiesScreen />);

    expect(screen.getByTestId("activity-route-path").getAttribute("points")).toBe(
      "278.54,379.51 292.2,370.88 305.85,359.36",
    );
    expect(screen.getAllByTestId("activity-map-preview-tile")).toHaveLength(2);
  });

  it("does not duplicate distance and elevation badges over the map", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              location: {
                centroidLat: 37.7749,
                centroidLng: -122.4194,
                mapPreview: {
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
                },
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

    render(<ActivitiesScreen />);

    expect(screen.getAllByText("5.0 km")).toHaveLength(1);
    expect(screen.getAllByText("120 m")).toHaveLength(1);
  });

  it("renders exported map preview tiles inside the thumbnail", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              location: {
                centroidLat: 37.7749,
                centroidLng: -122.4194,
                mapPreview: {
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
                  routePath: [
                    { x: 250, y: 300 },
                    { x: 350, y: 400 },
                  ],
                },
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

    render(<ActivitiesScreen />);

    const previewTile = screen.getByTestId("activity-map-preview-tile");
    expect(screen.getByTestId("activity-route-viewport")).toBeDefined();
    expect(previewTile.getAttribute("style")).toContain("left: 0px");
    expect(previewTile.getAttribute("style")).toContain("top: 21px");
    expect(previewTile.getAttribute("style")).toContain("width: 24px");
    expect(previewTile.getAttribute("style")).toContain("height: 24px");
  });
});
