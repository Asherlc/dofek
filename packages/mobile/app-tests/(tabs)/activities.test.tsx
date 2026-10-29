// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { AccessibilityInfo, Alert, Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activity,
  activityListQuery,
  climbingSourceLocation,
  emptyActivityOverviewQuery,
  type MockOverviewQuery,
  type MockQuery,
  recordedGpsLocation,
  type WeekListQueryOptions,
} from "../../app-fixtures/(tabs)/activities-test-helpers";
import { branchingActivitySourceTree } from "../../app-fixtures/activity-source-tree";
import { activityImageFixture } from "../../components/activity-images-test-helpers";

let mockQuery: MockQuery;
let mockCalendarQuery: MockQuery;
let mockOverviewQuery: MockOverviewQuery;
let weekListInput: unknown;
let weekListOptions: WeekListQueryOptions | undefined;
let calendarDataInput: unknown;
let calendarDataOptions: { placeholderData?: (previousData: unknown) => unknown } | undefined;
let overviewInput: unknown;
let overviewOptions: { placeholderData?: (previousData: unknown) => unknown } | undefined;
let bulkDeleteMutateAsync: CallableVitestMock;
let mergeMutateAsync: CallableVitestMock;
let mockMergeShouldFail: boolean;
let invalidateWeekList: CallableVitestMock;
let invalidateActivityOverview: CallableVitestMock;
let invalidateCalendarData: CallableVitestMock;
let invalidateActivityList: CallableVitestMock;
let invalidateDataHealth: CallableVitestMock;
let mockDataHealthQuery: {
  data: unknown;
  isLoading: boolean;
  error: Error | null;
};
let processingStatusInput: unknown;
const routerPush = vi.fn();
const mockImagesQuery = vi.hoisted(() => vi.fn());

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock("../../lib/trpc", () => ({
  trpc: {
    calendar: {
      weekList: {
        useQuery: (input: unknown, options: WeekListQueryOptions | undefined) => {
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
      images: { useQuery: mockImagesQuery },
      merge: {
        useMutation: (options?: {
          onSuccess?: () => Promise<void> | void;
          onError?: (error: Error) => void;
        }) => ({
          mutate: mergeMutateAsync.mockImplementation(async () => {
            if (mockMergeShouldFail) options?.onError?.(new Error("Merge failed"));
            else await options?.onSuccess?.();
          }),
          isPending: false,
          error: null,
        }),
      },
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
      dismiss: { useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }) },
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
  SvgXml: (props: Record<string, unknown>) => createElement("svg", props),
  SvgUri: (props: Record<string, unknown>) => createElement("svg", props),
  default: ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) =>
    createElement("svg", { ...props, "data-testid": props.testID }, children),
  Circle: ({ testID, ...props }: Record<string, unknown>) =>
    createElement("circle", { ...props, "data-testid": testID }),
  Polyline: ({ testID, ...props }: Record<string, unknown>) =>
    createElement("polyline", { ...props, "data-testid": testID }),
}));

import ActivitiesScreen from "../../app/(tabs)/activities";

afterEach(() => vi.useRealTimers());

describe("ActivitiesScreen", () => {
  it("uses the primary activity type for unnamed activity titles and accessible actions", () => {
    mockQuery = activityListQuery([
      activity({ name: null, activityType: "walking", primaryActivityType: "running" }),
    ]);

    render(<ActivitiesScreen />);

    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.getByRole("button", { name: /^Open Running,/ })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    expect(screen.getByRole("button", { name: /^Select Running,/ })).toBeDefined();
  });

  it("shows one downloaded photo for activities without a map", () => {
    mockQuery = activityListQuery([activity({ location: null })]);
    mockImagesQuery.mockReturnValue({
      data: {
        images: [activityImageFixture, { ...activityImageFixture, id: "photo-2" }],
        coverage: [],
        acquisition: [],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    render(<ActivitiesScreen />);
    expect(screen.getAllByLabelText("View from the summit")).toHaveLength(1);
    expect(mockImagesQuery).toHaveBeenCalledWith(
      { id: "activity-1" },
      expect.objectContaining({ meta: { persist: false } }),
    );
  });

  it("keeps provider-removed activities visible without requesting their retired photos", () => {
    mockQuery = activityListQuery([activity({ location: null, isProviderAbsent: true })]);
    render(<ActivitiesScreen />);
    expect(screen.getByText("Trainer Ride")).toBeTruthy();
    expect(mockImagesQuery).not.toHaveBeenCalled();
  });

  it.each([recordedGpsLocation(), climbingSourceLocation(), { kind: "processing" }])(
    "keeps map cards focused on their map rather than fetching a photo",
    (location) => {
      mockQuery = activityListQuery([activity({ location })]);
      render(<ActivitiesScreen />);
      expect(mockImagesQuery).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("View from the summit")).toBeNull();
    },
  );
  it.each([null, recordedGpsLocation()])(
    "keeps activity identity leading with a resolved source and location %j",
    (location) => {
      mockQuery = activityListQuery([
        activity({
          location,
          source: {
            tree: branchingActivitySourceTree,
            origin: {
              status: "resolved",
              memberActivityId: "00000000-0000-4000-8000-000000000001",
              providerId: "apple_health",
              sourceName: "Hang Ten Training",
            },
            primarySourceLabel: "Hang Ten (via Apple Health)",
            sourceCount: 2,
            overlapSummary: "2 matched source records",
          },
        }),
      ]);
      render(<ActivitiesScreen />);
      const icon = screen.getByTestId("activity-type-icon");
      const title = screen.getByText("Trainer Ride");
      expect(icon.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const sources = screen.getByRole("button", { name: "Sources: Hang Ten" });
      expect(
        title.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      if (location) {
        const map = screen.getByTestId("activity-route-viewport");
        expect(
          map.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    },
  );

  it("keeps a Garmin model thumbnail in its inline source disclosure", () => {
    mockQuery = activityListQuery([
      activity({
        source: {
          origin: {
            status: "resolved",
            memberActivityId: "00000000-0000-4000-8000-000000000001",
            providerId: "garmin",
            sourceName: "Forerunner 965",
          },
          primarySourceLabel: "Garmin · Forerunner 965",
          tree: {
            primary: {
              id: "garmin-record",
              providerId: "garmin",
              sourceName: "Forerunner 965",
              label: "Forerunner 965",
              description: null,
              url: null,
              children: [],
            },
            otherSources: [],
          },
          sourceCount: 1,
          overlapSummary: null,
        },
      }),
    ]);
    render(<ActivitiesScreen />);
    const source = screen.getByRole("button", { name: "Sources: Forerunner 965" });
    const thumbnail = source.querySelector("Image");
    expect(thumbnail).toBeTruthy();
    expect(thumbnail?.getAttribute("resizeMode")).toBe("contain");
    expect(thumbnail?.getAttribute("style")).toContain("width: 20px");
    expect(thumbnail?.getAttribute("style")).toContain("height: 20px");
    expect(screen.getByTestId("activity-type-icon")).toBeDefined();
  });

  it.each([false, true])(
    "keeps photos and source details independent of card action in selection mode %s",
    (selectMode) => {
      mockQuery = activityListQuery([
        activity({
          source: {
            tree: branchingActivitySourceTree,
            origin: {
              status: "resolved",
              memberActivityId: "00000000-0000-4000-8000-000000000001",
              providerId: "whoop",
              sourceName: null,
            },
            primarySourceLabel: "WHOOP",
            sourceCount: 1,
            overlapSummary: null,
          },
        }),
      ]);
      mockImagesQuery.mockReturnValue({
        data: { images: [activityImageFixture], coverage: [], acquisition: [] },
        error: null,
        isLoading: false,
        isFetching: false,
        refetch: vi.fn(),
      });
      render(<ActivitiesScreen />);
      if (selectMode) fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
      const sourceButton = screen.getByRole("button", { name: "Sources: Hang Ten" });
      const cardAction = screen.getByRole("button", {
        name: selectMode ? /^Select Trainer Ride/ : /^Open Trainer Ride/,
      });
      expect(cardAction.contains(sourceButton)).toBe(false);
      expect(sourceButton.parentElement?.closest("button")).toBeNull();
      const photo = screen.getByLabelText("View from the summit");
      expect(photo.closest('[pointer-events="none"]')).not.toBeNull();

      fireEvent.click(sourceButton);
      expect(screen.getByText("Apple Health")).toBeDefined();
      expect(routerPush).not.toHaveBeenCalled();
      if (selectMode) expect(screen.getByText("0 activities selected")).toBeDefined();
      fireEvent.click(sourceButton);
      fireEvent.click(cardAction);
      if (selectMode) {
        expect(screen.getByText("1 activity selected")).toBeDefined();
        expect(routerPush).not.toHaveBeenCalled();
      } else {
        expect(routerPush).toHaveBeenCalledWith("/activity/activity-1");
      }
    },
  );
  beforeEach(() => {
    mockImagesQuery.mockReset();
    mockImagesQuery.mockReturnValue({
      data: { images: [], coverage: [], acquisition: [] },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    mockQuery = { data: [], isLoading: false, isError: false, error: null };
    mockCalendarQuery = { data: [], isLoading: false, isError: false, error: null };
    mockOverviewQuery = emptyActivityOverviewQuery();
    weekListInput = undefined;
    calendarDataInput = undefined;
    calendarDataOptions = undefined;
    overviewInput = undefined;
    overviewOptions = undefined;
    bulkDeleteMutateAsync = vi.fn();
    mergeMutateAsync = vi.fn();
    mockMergeShouldFail = false;
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
    expect(screen.getByRole("button", { name: /72 min/ })).toBeTruthy();
  });

  it("uses QueryStatePanel for overview loading state", () => {
    mockOverviewQuery = { data: undefined, isLoading: true, isError: false, error: null };

    render(<ActivitiesScreen />);

    expect(screen.getByTestId("query-state-loading")).toBeDefined();
  });

  it("renders server-provided stat labels and values", () => {
    mockQuery = activityListQuery([activity()]);

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
    mockQuery = activityListQuery([activity()]);

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));

    expect(routerPush).toHaveBeenCalledWith("/activity/activity-1");
  });

  it("includes visible activity context in each accessible action name", () => {
    mockQuery = activityListQuery([activity()]);

    render(<ActivitiesScreen />);

    const activityButton = screen.getByRole("button", { name: /^Open Trainer Ride/ });
    expect(activityButton?.getAttribute("aria-label")).toContain("Open Trainer Ride");
    expect(activityButton?.getAttribute("aria-label")).toContain("1h");
    expect(activityButton?.getAttribute("aria-label")).toContain("Indoor Cycling");
  });

  it("includes available route measurements in each accessible action name", () => {
    mockQuery = activityListQuery([
      activity({
        activityType: "cycling",
        modality: "road",
        distanceMeters: 5000,
        distanceState: { status: "available" },
        elevationGainM: 120,
        elevationState: { status: "available" },
        location: null,
      }),
    ]);

    render(<ActivitiesScreen />);

    const activityButton = screen.getByRole("button", { name: /^Open Trainer Ride/ });
    expect(activityButton?.getAttribute("aria-label")).toContain("Distance 5.0 km");
    expect(activityButton?.getAttribute("aria-label")).toContain("Elevation 120 m");
  });

  it.each([
    { modality: "indoor", distanceMeters: 0, elevationGainM: null },
    { modality: "virtual", distanceMeters: 0, elevationGainM: null },
    { modality: "indoor", distanceMeters: 25_000, elevationGainM: 400 },
    { modality: "virtual", distanceMeters: 25_000, elevationGainM: 400 },
  ])(
    "uses training stats in visible and accessible $modality cycling cards with distance $distanceMeters",
    ({ modality, distanceMeters, elevationGainM }) => {
      mockQuery = activityListQuery([
        activity({
          activityType: "cycling",
          modality,
          distanceMeters,
          distanceState: { status: "available" },
          elevationGainM,
          elevationState:
            elevationGainM === null
              ? { status: "missing", reason: "Elevation not recorded" }
              : { status: "available" },
          stats: [
            { status: "available", label: "Training Stress Score", value: "100" },
            { status: "missing", label: "Average Power", reason: "Power not recorded" },
          ],
        }),
      ]);

      render(<ActivitiesScreen />);

      const activityButton = screen.getByRole("button", { name: /^Open Trainer Ride/ });
      expect(
        within(activityButton.parentElement ?? activityButton).getByText("Training Stress Score"),
      ).toBeDefined();
      expect(within(activityButton.parentElement ?? activityButton).getByText("100")).toBeDefined();
      expect(
        within(activityButton.parentElement ?? activityButton).queryByText("Distance"),
      ).toBeNull();
      expect(
        within(activityButton.parentElement ?? activityButton).queryByText(/Elevation/),
      ).toBeNull();
      expect(activityButton.getAttribute("aria-label")).toContain("Training Stress Score 100");
      expect(activityButton.getAttribute("aria-label")).toContain(
        "Average Power unavailable: Power not recorded",
      );
      expect(activityButton.getAttribute("aria-label")).not.toMatch(/Distance|Elevation/);
    },
  );

  it.each([
    { activityType: "cycling", modality: "road" },
    { activityType: "running", modality: "indoor" },
  ])("keeps measured zero in accessible $modality $activityType cards", (classification) => {
    mockQuery = activityListQuery([
      activity({
        ...classification,
        distanceMeters: 0,
        distanceState: { status: "available" },
        elevationGainM: 0,
        elevationState: { status: "available" },
      }),
    ]);

    render(<ActivitiesScreen />);

    const activityButton = screen.getByRole("button", { name: /^Open Trainer Ride/ });
    expect(activityButton.getAttribute("aria-label")).toContain("Distance 0.0 km");
    expect(activityButton.getAttribute("aria-label")).toContain("Elevation 0 m");
    expect(
      within(activityButton.parentElement ?? activityButton).getByText("Distance"),
    ).toBeDefined();
    expect(
      within(activityButton.parentElement ?? activityButton).getByText("Elevation"),
    ).toBeDefined();
  });

  it.each([null, "Indoor Cycling"])(
    "labels an activity named %s without repeating its type",
    (name) => {
      mockQuery = activityListQuery([activity({ name })]);

      render(<ActivitiesScreen />);

      const openButton = screen.getByRole("button", { name: /^Open Indoor Cycling/ });
      expect(openButton.getAttribute("aria-label")?.match(/Indoor Cycling/g)).toHaveLength(1);
      expect(
        within(openButton.parentElement ?? openButton).getAllByText("Indoor Cycling"),
      ).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
      const selectButton = screen.getByRole("button", { name: /^Select Indoor Cycling/ });
      expect(selectButton.getAttribute("aria-label")?.match(/Indoor Cycling/g)).toHaveLength(1);
    },
  );

  it("toggles selected activities instead of navigating in select mode", () => {
    mockQuery = activityListQuery([activity()]);

    render(<ActivitiesScreen />);
    expect(screen.queryByText("Choose activities to merge or delete.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    expect(screen.getByText("Choose activities to merge or delete.")).toBeDefined();
    expect(screen.getByText("0 activities selected").getAttribute("accessibilityliveregion")).toBe(
      "polite",
    );
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));

    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.getByText("1 activity selected").getAttribute("accessibilityliveregion")).toBe(
      "polite",
    );
  });

  it("announces selected activity count changes on iOS", async () => {
    mockQuery = activityListQuery([activity()]);
    vi.spyOn(Platform, "OS", "get").mockReturnValue("ios");
    const announceForAccessibility = vi
      .spyOn(AccessibilityInfo, "announceForAccessibility")
      .mockImplementation(() => undefined);

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    await waitFor(() =>
      expect(announceForAccessibility).toHaveBeenLastCalledWith("0 activities selected"),
    );
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));

    await waitFor(() =>
      expect(announceForAccessibility).toHaveBeenLastCalledWith("1 activity selected"),
    );
  });

  it("bulk deletes selected activities after confirmation", async () => {
    mockQuery = activityListQuery([activity()]);
    vi.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === "Delete")?.onPress?.();
    });

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(bulkDeleteMutateAsync).toHaveBeenCalledWith({ ids: ["activity-1"] });
      expect(invalidateWeekList).toHaveBeenCalled();
      expect(invalidateActivityOverview).toHaveBeenCalled();
      expect(invalidateCalendarData).toHaveBeenCalled();
      expect(invalidateActivityList).toHaveBeenCalled();
    });
  });

  it("merges selected same-type activities after native confirmation", async () => {
    mockQuery = activityListQuery([
      activity(),
      activity({ id: "activity-2", name: "Second Ride" }),
    ]);
    vi.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      expect(_title).toBe("Merge Activities");
      buttons?.find((button) => button.text === "Merge")?.onPress?.();
    });
    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Second Ride,/ }));
    fireEvent.click(screen.getByText("Merge"));
    await waitFor(() => {
      expect(mergeMutateAsync).toHaveBeenCalledWith({ ids: ["activity-1", "activity-2"] });
      expect(invalidateWeekList).toHaveBeenCalled();
      expect(invalidateActivityOverview).toHaveBeenCalled();
      expect(invalidateCalendarData).toHaveBeenCalled();
      expect(invalidateActivityList).toHaveBeenCalled();
    });
  });

  it("disables merge when fewer than two activities or mixed types are selected", () => {
    mockQuery = activityListQuery([
      activity(),
      activity({ id: "activity-2", name: "Run", activityType: "running" }),
    ]);
    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    const merge = screen.getByRole("button", { name: "Merge selected activities" });
    expect(merge.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));
    expect(merge.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Run,/ }));
    expect(merge.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Select activities of one type to merge.")).toBeDefined();
  });

  it("keeps selected activities selected when merge fails", async () => {
    mockMergeShouldFail = true;
    mockQuery = activityListQuery([
      activity(),
      activity({ id: "activity-2", name: "Second Ride" }),
    ]);
    vi.spyOn(Alert, "alert").mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === "Merge")?.onPress?.();
    });
    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Second Ride,/ }));
    fireEvent.click(screen.getByText("Merge"));
    await waitFor(() => {
      expect(mergeMutateAsync).toHaveBeenCalledWith({ ids: ["activity-1", "activity-2"] });
      expect(screen.getByText("2 activities selected")).toBeDefined();
      expect(Alert.alert).toHaveBeenCalledWith("Unable to merge activities", "Merge failed");
    });
  });

  it("clears selected activities when the activity type filter changes", () => {
    mockQuery = activityListQuery([activity()]);
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
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));
    fireEvent.click(screen.getByText("Running"));

    expect(screen.queryByText("1 activity selected")).toBeNull();
    expect(screen.getByRole("button", { name: "Select activities" })).toBeDefined();
  });

  it("clears selected activities when the date range changes", () => {
    mockQuery = activityListQuery([activity()]);

    render(<ActivitiesScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByRole("button", { name: /^(Open|Select|Deselect) Trainer Ride,/ }));
    fireEvent.click(screen.getByText("8 weeks"));

    expect(screen.queryByText("1 activity selected")).toBeNull();
    expect(screen.getByRole("button", { name: "Select activities" })).toBeDefined();
  });

  it("paginates the activity card history", () => {
    mockQuery = activityListQuery(
      Array.from({ length: 21 }, (_, index) =>
        activity({
          id: `activity-${index + 1}`,
          name: `Ride ${index + 1}`,
        }),
      ),
    );

    render(<ActivitiesScreen />);

    expect(screen.getByText("Ride 1")).toBeDefined();
    expect(screen.queryByText("Ride 21")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next activities page" }));

    expect(screen.queryByText("Ride 1")).toBeNull();
    expect(screen.getByText("Ride 21")).toBeDefined();
  });

  it.each([1, 2])("shows %i source climbing points without inventing a route", (pointCount) => {
    mockQuery.data = [
      {
        date: "2026-03-18",
        activities: [
          activity({
            activityType: "climbing",
            name: "Boulder Canyon climbing",
            location: climbingSourceLocation(pointCount),
          }),
        ],
      },
    ];

    render(<ActivitiesScreen />);

    const points = screen.getAllByTestId("activity-source-point");
    expect(points).toHaveLength(pointCount);
    const markers = screen.getAllByTestId("activity-source-marker");
    expect(markers[0]?.style.left).toBe("50%");
    expect(markers[0]?.style.top).toBe("50%");
    expect(screen.queryByTestId("activity-route-path")).toBeNull();
    expect(screen.getByText("Training Stress Score")).toBeDefined();
    const row = screen.getByRole("button", { name: /Open Boulder Canyon climbing/ });
    expect(row.getAttribute("aria-label")).toContain(
      "Area location: Boulder Canyon · Mountain Project",
    );
    expect(row.getAttribute("aria-label")).not.toContain("Distance unavailable");
    if (pointCount === 2) {
      expect(Number.parseFloat(markers[1]?.style.left ?? "")).toBeCloseTo(68.36, 2);
      expect(Number.parseFloat(markers[1]?.style.top ?? "")).toBeCloseTo(34.72, 2);
      expect(row.getAttribute("aria-label")).toContain("Climb location: Second climb · OpenBeta");
    }
    fireEvent.click(row);
    expect(routerPush).toHaveBeenCalledWith("/activity/activity-1");
  });

  it("replaces a failed map snapshot with a fallback", async () => {
    mockQuery = activityListQuery([
      activity({
        location: recordedGpsLocation(),
        distanceMeters: 5000,
        elevationGainM: 120,
        distanceState: { status: "available" },
        elevationState: { status: "available" },
      }),
    ]);

    render(<ActivitiesScreen />);

    fireEvent(
      screen.getByTestId("activity-map-panel"),
      new CustomEvent("layout", { detail: { width: 320, height: 180 } }),
    );
    fireEvent.error(await screen.findByTestId("activity-map-preview"));

    expect(screen.getByLabelText("Activity location unavailable")).toBeDefined();
  });

  it("draws a route overlay using server-projected path points", () => {
    mockQuery = activityListQuery([
      activity({
        location: recordedGpsLocation({
          routePath: [
            { x: 278.54, y: 379.51 },
            { x: 292.2, y: 370.88 },
            { x: 305.85, y: 359.36 },
          ],
        }),
        distanceMeters: 5000,
        elevationGainM: 120,
        distanceState: { status: "available" },
        elevationState: { status: "available" },
      }),
    ]);

    render(<ActivitiesScreen />);

    expect(screen.getByTestId("activity-route-path").getAttribute("points")).toBe(
      "278.54,379.51 292.2,370.88 305.85,359.36",
    );
    expect(screen.getByTestId("activity-route-viewport")).toBeTruthy();
  });

  it("does not duplicate distance and elevation badges over the map", () => {
    mockQuery = activityListQuery([
      activity({
        location: recordedGpsLocation(),
        distanceMeters: 5000,
        elevationGainM: 120,
        distanceState: { status: "available" },
        elevationState: { status: "available" },
      }),
    ]);

    render(<ActivitiesScreen />);

    expect(screen.getAllByText("5.0 km")).toHaveLength(1);
    expect(screen.getAllByText("120 m")).toHaveLength(1);
  });

  it("renders the native preview across the responsive viewport", async () => {
    mockQuery = activityListQuery([
      activity({
        location: recordedGpsLocation({
          routePath: [
            { x: 250, y: 300 },
            { x: 350, y: 400 },
          ],
        }),
        distanceMeters: 5000,
        elevationGainM: 120,
        distanceState: { status: "available" },
        elevationState: { status: "available" },
      }),
    ]);

    render(<ActivitiesScreen />);

    fireEvent(
      screen.getByTestId("activity-map-panel"),
      new CustomEvent("layout", { detail: { width: 320, height: 180 } }),
    );
    const preview = await screen.findByTestId("activity-map-preview");
    fireEvent.load(preview);
    expect(screen.getByLabelText("Activity location map")).toBeTruthy();
  });

  it("shows a full-width map processing state while server map geometry is pending", () => {
    mockQuery.data = [
      { date: "2026-03-18", activities: [activity({ location: { kind: "processing" } })] },
    ];
    render(<ActivitiesScreen />);
    expect(screen.getByRole("progressbar", { name: "Processing map" }).textContent).toBe(
      "Processing map…",
    );
    expect(
      screen.getByRole("button", { name: /Open Trainer Ride/ }).getAttribute("aria-label"),
    ).toContain("Processing map");
  });

  it("polls pending map geometry without polling settled or absent map states", () => {
    render(<ActivitiesScreen />);
    expect(
      weekListOptions?.refetchInterval?.({
        state: { data: [{ activities: [activity({ location: { kind: "processing" } })] }] },
      }),
    ).toEqual(expect.any(Number));
    expect(
      weekListOptions?.refetchInterval?.({
        state: { data: [{ activities: [activity({ location: null })] }] },
      }),
    ).toBe(false);
    expect(weekListOptions?.refetchInterval?.({ state: { data: undefined } })).toBe(false);
  });
});
