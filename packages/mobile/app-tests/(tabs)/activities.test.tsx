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
let mockCalendarQuery: MockQuery;
let mockOverviewQuery: {
  data:
    | {
        activityCount: number;
        totalMinutes: number;
        totalDistanceMeters: number | null;
        totalDistanceState: { status: "available" } | { status: "missing"; reason: string };
        totalElevationGainM: number | null;
        totalElevationState: { status: "available" } | { status: "missing"; reason: string };
        activityTypes: string[];
        comparison?: {
          periodLabel: string;
          activityCount: { magnitude: number; trend: "higher" | "lower" | "unchanged" };
          totalMinutes: { magnitude: number; trend: "higher" | "lower" | "unchanged" };
          totalDistanceMeters: {
            magnitude: number | null;
            trend: "higher" | "lower" | "unchanged" | "unavailable";
            state: { status: "available" } | { status: "missing"; reason: string };
          };
          totalElevationGainM: {
            magnitude: number | null;
            trend: "higher" | "lower" | "unchanged" | "unavailable";
            state: { status: "available" } | { status: "missing"; reason: string };
          };
        };
      }
    | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
};
let weekListInput: unknown;
let weekListOptions: { placeholderData?: (previousData: unknown) => unknown } | undefined;
let calendarDataInput: unknown;
let calendarDataOptions: { placeholderData?: (previousData: unknown) => unknown } | undefined;
let overviewInput: unknown;
let overviewOptions: { placeholderData?: (previousData: unknown) => unknown } | undefined;
let bulkDeleteMutateAsync: ReturnType<typeof vi.fn>;
let invalidateWeekList: ReturnType<typeof vi.fn>;
let invalidateActivityOverview: ReturnType<typeof vi.fn>;
let invalidateCalendarData: ReturnType<typeof vi.fn>;
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
      calendarData: {
        useQuery: (
          input: unknown,
          options: { placeholderData?: (previousData: unknown) => unknown } | undefined,
        ) => {
          calendarDataInput = input;
          calendarDataOptions = options;
          return mockCalendarQuery;
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
        calendarData: { invalidate: invalidateCalendarData },
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

import ActivitiesScreen from "../../app/(tabs)/activities";

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
    distanceMeters: null,
    distanceState: { status: "missing", reason: "Distance not recorded" },
    elevationGainM: null,
    elevationState: { status: "missing", reason: "Elevation not recorded" },
    location: null,
    tss: 100,
    stats: [{ status: "available", label: "Training Stress Score", value: "100" }],
    ...overrides,
  };
}

describe("ActivitiesScreen", () => {
  beforeEach(() => {
    mockQuery = { data: [], isLoading: false, isError: false, error: null };
    mockCalendarQuery = { data: [], isLoading: false, isError: false, error: null };
    mockOverviewQuery = {
      data: {
        activityCount: 0,
        totalMinutes: 0,
        totalDistanceMeters: 0,
        totalDistanceState: { status: "available" },
        totalElevationGainM: 0,
        totalElevationState: { status: "available" },
        activityTypes: [],
      },
      isLoading: false,
      isError: false,
      error: null,
    };
    weekListInput = undefined;
    calendarDataInput = undefined;
    calendarDataOptions = undefined;
    overviewInput = undefined;
    overviewOptions = undefined;
    bulkDeleteMutateAsync = vi.fn();
    invalidateWeekList = vi.fn();
    invalidateActivityOverview = vi.fn();
    invalidateCalendarData = vi.fn();
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

  it("loads a server-owned, labeled activity heatmap for the selected weeks", () => {
    mockCalendarQuery = {
      data: [
        {
          date: "2026-03-18",
          activityCount: 1,
          totalMinutes: 72,
          activityTypes: ["running"],
          trainingTimeBand: "high",
          trainingTimeMeaning: "High training volume; compare with recovery.",
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    expect(calendarDataInput).toEqual({ days: 28 });
    expect(calendarDataOptions?.placeholderData?.([])).toBeUndefined();
    const previousCalendarData = [{ date: "2026-03-10" }];
    expect(calendarDataOptions?.placeholderData?.(previousCalendarData)).toBe(previousCalendarData);
    expect(screen.getByText("Training time (minutes per day)")).toBeTruthy();
    expect(screen.getByText("High training volume; compare with recovery.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /72 minutes of training time/ })).toBeTruthy();
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
    expect(screen.getByText("Source overlap")).toBeDefined();
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
        totalDistanceState: { status: "available" },
        totalElevationGainM: 520,
        totalElevationState: { status: "available" },
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

  it("renders server-computed changes from the previous comparable period", () => {
    mockOverviewQuery = {
      data: {
        activityCount: 12,
        totalMinutes: 615,
        totalDistanceMeters: 42300,
        totalDistanceState: { status: "available" },
        totalElevationGainM: 520,
        totalElevationState: { status: "available" },
        activityTypes: ["running", "cycling"],
        comparison: {
          periodLabel: "previous 4 weeks",
          activityCount: { magnitude: 1, trend: "higher" },
          totalMinutes: { magnitude: 90, trend: "lower" },
          totalDistanceMeters: {
            magnitude: 0,
            trend: "unchanged",
            state: { status: "available" },
          },
          totalElevationGainM: {
            magnitude: null,
            trend: "unavailable",
            state: { status: "missing", reason: "Previous period: Elevation gain not recorded" },
          },
        },
      },
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    expect(screen.getByText("1 more vs previous 4 weeks")).toBeDefined();
    expect(screen.getByText("1h 30m less vs previous 4 weeks")).toBeDefined();
    expect(screen.getByText("No change vs previous 4 weeks")).toBeDefined();
    expect(
      screen.getByText("Comparison unavailable: Previous period: Elevation gain not recorded"),
    ).toBeDefined();
    expect(screen.getByLabelText("Activities 12. 1 more vs previous 4 weeks")).toBeDefined();
    expect(screen.getByLabelText("Time 10h 15m. 1h 30m less vs previous 4 weeks")).toBeDefined();
  });

  it("distinguishes unavailable overview measurements from measured zero", () => {
    mockOverviewQuery = {
      data: {
        activityCount: 2,
        totalMinutes: 90,
        totalDistanceMeters: null,
        totalDistanceState: { status: "missing", reason: "Distance not recorded" },
        totalElevationGainM: null,
        totalElevationState: { status: "missing", reason: "Elevation not recorded" },
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
      totalDistanceState: { status: "available" },
      totalElevationGainM: 0,
      totalElevationState: { status: "available" },
      activityTypes: ["running"],
    };
    rerender(<ActivitiesScreen />);

    expect(screen.getByText("0.0 km")).toBeDefined();
    expect(screen.getByText("0 m")).toBeDefined();
  });

  it("renders available partial overview measurements and comparisons", () => {
    mockOverviewQuery = {
      data: {
        activityCount: 4,
        totalMinutes: 280,
        totalDistanceMeters: 12500,
        totalDistanceState: { status: "available" },
        totalElevationGainM: 180,
        totalElevationState: { status: "available" },
        activityTypes: ["running", "cycling"],
        comparison: {
          periodLabel: "previous 4 weeks",
          activityCount: { magnitude: 1, trend: "higher" },
          totalMinutes: { magnitude: 60, trend: "higher" },
          totalDistanceMeters: {
            magnitude: 2500,
            trend: "higher",
            state: { status: "available" },
          },
          totalElevationGainM: {
            magnitude: 50,
            trend: "higher",
            state: { status: "available" },
          },
        },
      },
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    expect(screen.getByText("12.5 km")).toBeDefined();
    expect(screen.getByText("180 m")).toBeDefined();
    expect(screen.getByText("2.5 km more vs previous 4 weeks")).toBeDefined();
    expect(screen.getByText("50 m more vs previous 4 weeks")).toBeDefined();
    expect(
      screen.getByLabelText("Distance 12.5 km. 2.5 km more vs previous 4 weeks"),
    ).toBeDefined();
    expect(screen.getByLabelText("Elevation 180 m. 50 m more vs previous 4 weeks")).toBeDefined();
  });

  it("passes selected activity type to the activity list query", () => {
    mockOverviewQuery = {
      data: {
        activityCount: 1,
        totalMinutes: 60,
        totalDistanceMeters: 5000,
        totalDistanceState: { status: "available" },
        totalElevationGainM: 120,
        totalElevationState: { status: "available" },
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

  it("includes available route measurements in each accessible action name", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              distanceMeters: 5000,
              distanceState: { status: "available" },
              elevationGainM: 120,
              elevationState: { status: "available" },
              location: null,
            }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesScreen />);

    const activityButton = screen.getByText("Trainer Ride").closest("button");
    expect(activityButton?.getAttribute("aria-label")).toContain("Distance 5.0 km");
    expect(activityButton?.getAttribute("aria-label")).toContain("Elevation 120 m");
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
      expect(invalidateCalendarData).toHaveBeenCalled();
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
        totalDistanceState: { status: "available" },
        totalElevationGainM: 120,
        totalElevationState: { status: "available" },
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
              },
              distanceMeters: 5000,
              elevationGainM: 120,
              distanceState: { status: "available" },
              elevationState: { status: "available" },
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
              },
              distanceMeters: 5000,
              elevationGainM: 120,
              distanceState: { status: "available" },
              elevationState: { status: "available" },
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
              },
              distanceMeters: 5000,
              elevationGainM: 120,
              distanceState: { status: "available" },
              elevationState: { status: "available" },
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
              },
              distanceMeters: 5000,
              elevationGainM: 120,
              distanceState: { status: "available" },
              elevationState: { status: "available" },
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
