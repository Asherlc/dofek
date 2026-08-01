// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { AccessibilityInfo, Alert, Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
        totalDistanceMeters: number | null;
        totalElevationGainM: number | null;
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
let processingStatusInput: unknown;
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
    processing: {
      status: {
        useQuery: (input: unknown) => {
          processingStatusInput = input;
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
      processing: {
        status: { invalidate: invalidateDataHealth },
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
  Circle: (props: Record<string, unknown>) => createElement("circle", props),
  Polyline: ({ testID, ...props }: Record<string, unknown>) =>
    createElement("polyline", { ...props, "data-testid": testID }),
}));

import ActivitiesScreen from "./activities";

afterEach(() => vi.useRealTimers());

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: "activity-1",
    name: "Trainer Ride",
    activityType: "indoor_cycling",
    startedAt: "2026-03-18T07:00:00.000Z",
    endedAt: "2026-03-18T08:00:00.000Z",
    localTimeContext: {
      timezone: null,
      startUtcOffsetMinutes: 60,
      endUtcOffsetMinutes: 60,
      source: "provider_offset",
    },
    durationMin: 60,
    source: {
      primarySourceLabel: "Wahoo",
      sourceCount: 1,
      overlapSummary: null,
    },
    lastProcessedAt: "2026-03-18T08:05:00.000Z",
    location: null,
    tss: 100,
    stats: [{ status: "available", label: "Training Stress Score", value: "100" }],
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
    processingStatusInput = undefined;
    invalidateDataHealth = vi.fn();
    routerPush.mockReset();
    vi.restoreAllMocks();
  });

  it("shows activity progress while summaries are updating", () => {
    mockDataHealthQuery = {
      data: {
        overallStatus: "active",
        generatedAt: "2026-06-30T08:00:00.000Z",
        scope: { providerId: null, datasets: ["activity"] },
        operations: [],
        datasets: [
          {
            key: "activity",
            label: "Activities",
            rawRows: 12,
            latestRawAt: "2026-06-30T07:00:00.000Z",
            latestReadModelAt: null,
            cdcLagSeconds: null,
            readModelLagSeconds: null,
            status: "active",
            progressPercentage: 60,
            message: "Activities are updating.",
          },
        ],
      },
      isLoading: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    expect(processingStatusInput).toEqual({ datasets: ["activity"] });
    expect(screen.getByText("Recomputing activities")).toBeDefined();
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

  it("renders server-authored source overlap and processing freshness", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T08:08:00.000Z"));
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              source: {
                primarySourceLabel: "Wahoo",
                sourceCount: 2,
                overlapSummary: "2 matched source records · Wahoo selected by source priority",
              },
              lastProcessedAt: "2026-03-18T08:07:00.000Z",
            }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    expect(screen.getByText("Wahoo")).toBeDefined();
    expect(
      screen.getByText("2 matched source records · Wahoo selected by source priority"),
    ).toBeDefined();
    expect(screen.getByText("Processed 1m ago")).toBeDefined();
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

  it("distinguishes unavailable overview measurements from measured zero", () => {
    mockOverviewQuery = {
      data: {
        activityCount: 2,
        totalMinutes: 90,
        totalDistanceMeters: null,
        totalElevationGainM: null,
        activityTypes: ["running"],
      },
      isLoading: false,
      isError: false,
      error: null,
    };

    const { rerender } = render(<ActivitiesScreen />);

    expect(screen.getByText("Distance not recorded")).toBeDefined();
    expect(screen.getByText("Elevation unavailable")).toBeDefined();
    expect(screen.queryByText("0.0 km")).toBeNull();
    expect(screen.queryByText("0 m")).toBeNull();

    mockOverviewQuery.data = {
      activityCount: 2,
      totalMinutes: 90,
      totalDistanceMeters: 0,
      totalElevationGainM: 0,
      activityTypes: ["running"],
    };
    rerender(<ActivitiesScreen />);

    expect(screen.getByText("0.0 km")).toBeDefined();
    expect(screen.getByText("0 m")).toBeDefined();
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

  it("includes visible activity context in each accessible action name", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    const activityButton = screen.getByText("Trainer Ride").closest("button");
    expect(activityButton?.getAttribute("aria-label")).toContain("Open Trainer Ride");
    expect(activityButton?.getAttribute("aria-label")).toContain("1h");
    expect(activityButton?.getAttribute("aria-label")).toContain("Indoor Cycling");
  });

  it("does not repeat the activity type when an activity has no custom name", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [activity({ name: null })],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    const openButton = screen.getByRole("button", { name: /^Open Indoor Cycling/ });
    expect(openButton.getAttribute("aria-label")?.match(/Indoor Cycling/g)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    const selectButton = screen.getByRole("button", { name: /^Select Indoor Cycling/ });
    expect(selectButton.getAttribute("aria-label")?.match(/Indoor Cycling/g)).toHaveLength(1);
  });

  it("toggles selected activities instead of navigating in select mode", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);
    expect(screen.getByText("Choose one or more activities to delete.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    expect(screen.getByText("0 activities selected").getAttribute("accessibilityliveregion")).toBe(
      "polite",
    );
    fireEvent.click(screen.getByText("Trainer Ride"));

    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.getByText("1 activity selected").getAttribute("accessibilityliveregion")).toBe(
      "polite",
    );
  });

  it("announces selected activity count changes on iOS", async () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };
    vi.spyOn(Platform, "OS", "get").mockReturnValue("ios");
    const announceForAccessibility = vi
      .spyOn(AccessibilityInfo, "announceForAccessibility")
      .mockImplementation(() => undefined);

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    await waitFor(() =>
      expect(announceForAccessibility).toHaveBeenLastCalledWith("0 activities selected"),
    );
    fireEvent.click(screen.getByText("Trainer Ride"));

    await waitFor(() =>
      expect(announceForAccessibility).toHaveBeenLastCalledWith("1 activity selected"),
    );
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
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.click(screen.getByText("Running"));

    expect(screen.queryByText("1 activity selected")).toBeNull();
    expect(screen.getByRole("button", { name: "Select activities" })).toBeDefined();
  });

  it("clears selected activities when the date range changes", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.click(screen.getByText("8 weeks"));

    expect(screen.queryByText("1 activity selected")).toBeNull();
    expect(screen.getByRole("button", { name: "Select activities" })).toBeDefined();
  });

  it("paginates the activity card history", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: Array.from({ length: 21 }, (_, index) =>
            activity({
              id: `activity-${index + 1}`,
              name: `Ride ${index + 1}`,
            }),
          ),
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    expect(screen.getByText("Ride 1")).toBeDefined();
    expect(screen.queryByText("Ride 21")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next activities page" }));

    expect(screen.queryByText("Ride 1")).toBeNull();
    expect(screen.getByText("Ride 21")).toBeDefined();
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
                distanceState: { status: "available" },
                elevationState: { status: "available" },
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
                distanceState: { status: "available" },
                elevationState: { status: "available" },
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
                distanceState: { status: "available" },
                elevationState: { status: "available" },
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
                distanceState: { status: "available" },
                elevationState: { status: "available" },
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
