// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
let overviewInput: unknown;
let overviewOptions: { placeholderData?: (previousData: unknown) => unknown } | undefined;
let bulkDeleteMutateAsync: ReturnType<typeof vi.fn>;
let invalidateWeekList: ReturnType<typeof vi.fn>;
let invalidateActivityOverview: ReturnType<typeof vi.fn>;
let invalidateActivityList: ReturnType<typeof vi.fn>;
const routerPush = vi.fn();

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock("../../lib/trpc", () => ({
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
          mutate: bulkDeleteMutateAsync.mockImplementation(async () => {
            await options?.onSuccess?.();
            return { success: true, deletedCount: 1 };
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
    routerPush.mockReset();
    vi.restoreAllMocks();
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

    render(<ActivitiesScreen />);

    fireEvent.error(screen.getByLabelText("Activity location map"));

    expect(screen.getByLabelText("Activity location unavailable")).toBeDefined();
  });
});
