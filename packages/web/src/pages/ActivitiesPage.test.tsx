/** @vitest-environment jsdom */

import type { ActivityImage } from "@dofek/training/activity-images";
import { QueryClient, QueryClientProvider, useQuery as useLiveQuery } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockQuery {
  data: Array<{ date: string; activities: ReturnType<typeof activity>[] }> | undefined;
  isLoading: boolean;
  isError: boolean;
  isSuccess?: boolean;
  isFetching?: boolean;
  isPlaceholderData?: boolean;
  plannedWindow?: { startDate: string; endDate: string } | null;
  totalCount?: number;
  page?: number;
  error: Error | null;
  refetch?: () => void;
}

let mockQuery: MockQuery;
const queryFixtureClient = new QueryClient();
let liveQueryClient: QueryClient | undefined;
let livePageFetch:
  | ((input: { page?: number; pageSize?: number; weeks?: number }) => Promise<unknown>)
  | undefined;
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
  refetch?: () => void;
};
let weekListInput: unknown;
let upcomingQueryInput: unknown;
let upcomingOptions: { placeholderData?: (previousData: unknown) => unknown } | undefined;
let mockUpcomingQuery: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  isSuccess?: boolean;
  error: Error | null;
  isFetching: boolean;
  isPlaceholderData?: boolean;
  refetch: () => void;
};
let invalidateUpcoming: CallableVitestMock;
const titleSearchQuery = vi.hoisted(() => vi.fn());
const locationSearchQuery = vi.hoisted(() => vi.fn());
const placeLookupQuery = vi.hoisted(() => vi.fn());
interface WeekListOptions {
  enabled?: boolean;
  placeholderData?: (previousData: unknown) => unknown;
  refetchInterval?: (query: {
    state: { data?: { days: Array<{ activities: Array<{ location: { kind: string } | null }> }> } };
  }) => number | false;
}
let weekListOptions: WeekListOptions | undefined;
let overviewInput: unknown;
let overviewOptions:
  | { enabled?: boolean; placeholderData?: (previousData: unknown) => unknown }
  | undefined;
let bulkDeleteMutate: CallableVitestMock;
let mergeMutate: CallableVitestMock;
let restoreProviderAbsentMutate: CallableVitestMock;
let invalidateWeekList: CallableVitestMock;
let invalidateActivityOverview: CallableVitestMock;
let invalidateCalendarData: CallableVitestMock;
let invalidateActivityList: CallableVitestMock;
let mockBulkDeleteShouldFail: boolean;
let mockDataHealthQuery: {
  data: unknown;
  isLoading: boolean;
  error: Error | null;
  refetch?: () => void;
};
let processingStatusInput: unknown;
const mockImagesUseQuery = vi.fn(
  (
    _input?: unknown,
    _options?: unknown,
  ): {
    data: { images: ActivityImage[]; coverage: unknown[]; acquisition: unknown[] };
    error: Error | null;
  } => ({
    data: { images: [], coverage: [], acquisition: [] },
    error: null,
  }),
);

interface BulkDeleteVariables {
  ids: string[];
}

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children: ReactNode;
    to: string;
    params?: { id: string };
    className?: string;
  }) => (
    <a className={className} href={params?.id ? to.replace("$id", params.id) : to}>
      {children}
    </a>
  ),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    activityLocation: {
      places: { useQuery: placeLookupQuery },
      search: { useInfiniteQuery: locationSearchQuery },
    },
    calendar: {
      searchActivities: { useInfiniteQuery: titleSearchQuery },
      weekListV2: {
        useQuery: (
          input: {
            page?: number;
            pageSize?: number;
            startDate?: string;
            endDate?: string;
          },
          options: WeekListOptions | undefined,
        ) => {
          weekListInput = input;
          weekListOptions = options;
          const liveQuery = useLiveQuery(
            {
              queryKey: ["activities", input],
              queryFn: () => livePageFetch?.(input),
              placeholderData: options?.placeholderData,
              retry: false,
              enabled: Boolean(livePageFetch),
            },
            liveQueryClient ?? queryFixtureClient,
          );
          if (livePageFetch) return liveQuery;
          // Same-range placeholders keep the prior page payload while input.page advances.
          const page = mockQuery.isPlaceholderData
            ? (mockQuery.page ?? 0)
            : (mockQuery.page ?? input.page ?? 0);
          const pageSize = input.pageSize ?? 20;
          let offset = 0;
          const days = mockQuery.data
            ?.map((day) => {
              const start = offset;
              offset += day.activities.length;
              return {
                ...day,
                activities: day.activities.filter(
                  (_activity, index) =>
                    start + index >= page * pageSize && start + index < (page + 1) * pageSize,
                ),
              };
            })
            .filter((day) => day.activities.length > 0);
          const plannedWindow =
            "plannedWindow" in mockQuery
              ? mockQuery.plannedWindow
              : input.startDate && input.endDate
                ? { startDate: input.startDate, endDate: input.endDate }
                : undefined;
          const data = days
            ? {
                days,
                totalCount: mockQuery.totalCount ?? offset,
                page,
                pageSize,
                ...(plannedWindow !== undefined ? { plannedWindow } : {}),
              }
            : undefined;
          return {
            ...mockQuery,
            data,
            isSuccess:
              mockQuery.isSuccess ??
              (!mockQuery.isLoading && !mockQuery.isError && data !== undefined),
            isFetching: mockQuery.isFetching ?? false,
            isPlaceholderData: mockQuery.isPlaceholderData ?? false,
          };
        },
      },
      activityOverview: {
        useQuery: (
          input: unknown,
          options:
            | { enabled?: boolean; placeholderData?: (previousData: unknown) => unknown }
            | undefined,
        ) => {
          overviewInput = input;
          overviewOptions = options;
          return mockOverviewQuery;
        },
      },
      upcomingWorkouts: {
        useQuery: (
          input: unknown,
          options: { placeholderData?: (previousData: unknown) => unknown } | undefined,
        ) => {
          upcomingQueryInput = input;
          upcomingOptions = options;
          return {
            ...mockUpcomingQuery,
            isSuccess:
              mockUpcomingQuery.isSuccess ??
              (!mockUpcomingQuery.isLoading &&
                !mockUpcomingQuery.isError &&
                mockUpcomingQuery.data !== undefined),
          };
        },
      },
    },
    activity: {
      images: {
        useQuery: (input: unknown, options: unknown) => mockImagesUseQuery(input, options),
      },
      merge: {
        useMutation: (options?: { onSuccess?: () => Promise<void> | void }) => ({
          mutate: mergeMutate.mockImplementation(async () => options?.onSuccess?.()),
          isPending: false,
          error: null,
        }),
      },
      bulkDelete: {
        useMutation: (options?: {
          onSuccess?: () => Promise<void> | void;
          onError?: (error: Error, variables: BulkDeleteVariables) => void;
        }) => ({
          mutate: bulkDeleteMutate.mockImplementation(async (variables: BulkDeleteVariables) => {
            if (mockBulkDeleteShouldFail) {
              options?.onError?.(new Error("Delete failed"), variables);
              return;
            }
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
      activityLocation: { search: { invalidate: vi.fn() } },
      calendar: {
        weekListV2: {
          invalidate: invalidateWeekList,
          getData: (input: unknown) => liveQueryClient?.getQueryData(["activities", input]),
        },
        activityOverview: { invalidate: invalidateActivityOverview },
        upcomingWorkouts: { invalidate: invalidateUpcoming },
        searchActivities: { invalidate: vi.fn() },
        calendarData: { invalidate: invalidateCalendarData },
      },
      activity: {
        list: { invalidate: invalidateActivityList },
      },
      processing: {
        status: { invalidate: vi.fn() },
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

import { branchingSourceTree } from "../components/ActivitySourceDisclosure.fixtures.ts";
import { samplePlannedWorkout } from "../components/PlannedWorkoutCard.fixtures.ts";
import { maps, resetMaps } from "../lib/maplibre-test-helpers.ts";
import { ActivitiesPage } from "./ActivitiesPage.tsx";

vi.mock("maplibre-gl", async () => (await import("../lib/maplibre-test-helpers.ts")).maplibreMock);

beforeEach(() => {
  queryFixtureClient.clear();
  liveQueryClient?.clear();
  liveQueryClient = undefined;
  livePageFetch = undefined;
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

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: "activity-1",
    name: "Trainer Ride",
    activityType: "indoor_cycling",
    primaryActivityType: null,
    startedAt: "2026-03-18T07:00:00.000Z",
    endedAt: "2026-03-18T08:00:00.000Z",
    localTimeContext: {
      timezone: null,
      startUtcOffsetMinutes: null,
      endUtcOffsetMinutes: null,
      source: "unknown",
    },
    durationMin: 60,
    source: {
      tree: { primary: null, otherSources: [] },
      origin: { status: "unresolved", candidateMemberActivityIds: [] },
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

const mapPreview = {
  width: 1024,
  height: 576,
  center: [-122.39868164, 37.76962919],
  zoom: 14,
  routePath: [
    { x: 278.54, y: 379.51 },
    { x: 292.2, y: 370.88 },
  ],
};

describe("ActivitiesPage", () => {
  it("uses the primary activity type for unnamed activity links and selection labels", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              name: null,
              activityType: "walking",
              primaryActivityType: "running",
            }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByRole("link", { name: "Running" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    expect(screen.getByRole("checkbox", { name: "Select Running" })).toBeDefined();
  });

  it("renders planned rows in the workout calendar without changing completed totals", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(new Date(2026, 10, 24, 12));
      mockUpcomingQuery = {
        ...mockUpcomingQuery,
        data: [
          {
            date: "2026-11-26",
            workouts: [samplePlannedWorkout],
          },
        ],
      };

      render(<ActivitiesPage />);

      expect(screen.getByRole("heading", { name: "Workout calendar" })).toBeDefined();
      expect(screen.getByText("Threshold intervals")).toBeDefined();
      expect(screen.getByText("Planned")).toBeDefined();
      expect(upcomingQueryInput).toMatchObject({
        dateRange: { startDate: "2026-11-23", endDate: "2026-11-29" },
      });
      expect(screen.getByText("0")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  beforeEach(() => {
    mockImagesUseQuery.mockReset();
    mockImagesUseQuery.mockReturnValue({
      data: { images: [], coverage: [], acquisition: [] },
      error: null,
    });
    mockQuery = { data: [], isLoading: false, isError: false, error: null };
    titleSearchQuery.mockReset();
    titleSearchQuery.mockReturnValue({ data: undefined, isPending: false });
    locationSearchQuery.mockReset();
    locationSearchQuery.mockReturnValue({});
    placeLookupQuery.mockReset();
    placeLookupQuery.mockReturnValue({});
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
    overviewInput = undefined;
    overviewOptions = undefined;
    upcomingQueryInput = undefined;
    upcomingOptions = undefined;
    mockUpcomingQuery = {
      data: undefined,
      isLoading: false,
      isError: false,
      isSuccess: false,
      error: null,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn(),
    };
    invalidateUpcoming = vi.fn();
    bulkDeleteMutate = vi.fn();
    mergeMutate = vi.fn();
    restoreProviderAbsentMutate = vi.fn();
    invalidateWeekList = vi.fn();
    invalidateActivityOverview = vi.fn();
    invalidateCalendarData = vi.fn();
    invalidateActivityList = vi.fn();
    mockBulkDeleteShouldFail = false;
    mockDataHealthQuery = { data: undefined, isLoading: false, error: null };
    processingStatusInput = undefined;
  });

  it("shows one notice when activity and processing status queries fail from the same offline condition", () => {
    const message = "We couldn't reach the server. Check your connection and try again.";
    mockOverviewQuery = { ...mockOverviewQuery, isError: true, error: new Error(message) };
    mockQuery = { ...mockQuery, isError: true, error: new Error(message) };
    mockDataHealthQuery = { data: undefined, isLoading: false, error: new Error(message) };

    render(<ActivitiesPage />);

    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.queryByText(/No activities in the last/)).toBeNull();
  });

  it("omits the activity summary when the overview shares an offline failure without cached data", () => {
    const message = "We couldn't reach the server. Check your connection and try again.";
    mockOverviewQuery = {
      ...mockOverviewQuery,
      data: undefined,
      isError: true,
      error: new Error(message),
    };
    mockQuery = { ...mockQuery, isError: true, error: new Error(message) };
    mockDataHealthQuery = { data: undefined, isLoading: false, error: new Error(message) };

    render(<ActivitiesPage />);

    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.queryAllByText("Loading…")).toHaveLength(0);
  });

  it("keeps a cached activity summary during a grouped overview failure", () => {
    const message = "We couldn't reach the server. Check your connection and try again.";
    mockOverviewQuery = {
      ...mockOverviewQuery,
      data: {
        activityCount: 7,
        totalMinutes: 0,
        totalDistanceMeters: 0,
        totalDistanceState: { status: "available" },
        totalElevationGainM: 0,
        totalElevationState: { status: "available" },
        activityTypes: [],
      },
      isError: true,
      error: new Error(message),
    };
    mockQuery = { ...mockQuery, isError: true, error: new Error(message) };
    mockDataHealthQuery = { data: undefined, isLoading: false, error: new Error(message) };

    render(<ActivitiesPage />);

    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.queryAllByText("Loading…")).toHaveLength(0);
  });

  it("shared connection retry refetches the failed activity list too", () => {
    const message = "We couldn't reach the server. Check your connection and try again.";
    const overviewRefetch = vi.fn();
    const listRefetch = vi.fn();
    const processingRefetch = vi.fn();
    mockOverviewQuery = {
      ...mockOverviewQuery,
      isError: true,
      error: new Error(message),
      refetch: overviewRefetch,
    };
    mockQuery = { ...mockQuery, isError: true, error: new Error(message), refetch: listRefetch };
    mockDataHealthQuery = {
      data: undefined,
      isLoading: false,
      error: new Error(message),
      refetch: processingRefetch,
    };

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(overviewRefetch).toHaveBeenCalledOnce();
    expect(listRefetch).toHaveBeenCalledOnce();
    expect(processingRefetch).toHaveBeenCalledOnce();
  });

  it("does not count a hidden overview failure while searching", () => {
    const message = "We couldn't reach the server. Check your connection and try again.";
    const searchRefetch = vi.fn();
    titleSearchQuery.mockReturnValue({
      data: undefined,
      isError: true,
      error: new Error(message),
      isFetching: false,
      refetch: searchRefetch,
    });
    mockOverviewQuery = { ...mockOverviewQuery, isError: true, error: new Error(message) };

    render(<ActivitiesPage />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search activity titles" }), {
      target: { value: "Ride" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(searchRefetch).toHaveBeenCalledOnce();
  });

  it("searches titles outside the browsing date range and returns to the list when cleared", () => {
    const fetchNextPage = vi.fn();
    titleSearchQuery.mockImplementation((_input, options) => ({
      data: options.enabled
        ? {
            pages: [
              {
                activities: [activity({ id: "old", name: "Golden Hill Ride", date: "2021-05-14" })],
              },
            ],
          }
        : undefined,
      hasNextPage: true,
      fetchNextPage,
    }));
    render(<ActivitiesPage />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search activity titles" }), {
      target: { value: " golden hi " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(titleSearchQuery).toHaveBeenLastCalledWith(
      { title: "golden hi", pageSize: 20 },
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByRole("link", { name: "Golden Hill Ride" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(fetchNextPage).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.queryByRole("link", { name: "Golden Hill Ride" })).toBeNull();
  });

  it("shows a retryable search error when refreshing an empty result fails", () => {
    const refetch = vi.fn();
    titleSearchQuery.mockReturnValue({
      data: { pages: [{ activities: [] }] },
      isError: true,
      error: new Error("Activity search is temporarily unavailable."),
      refetch,
    });
    render(<ActivitiesPage />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search activity titles" }), {
      target: { value: "golden hill" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.queryByText("No matching activities.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("uses the selected place, retains sport, and supports pagination and clearing", () => {
    const fetchNextPage = vi.fn();
    const refetch = vi.fn();
    if (mockOverviewQuery.data) mockOverviewQuery.data.activityTypes = ["running"];
    placeLookupQuery.mockImplementation((_input, options) => ({
      data: options.enabled
        ? [{ id: "oakland", label: "Oakland, CA", latitude: 37.8, longitude: -122.3 }]
        : undefined,
    }));
    locationSearchQuery.mockImplementation((input, options) => {
      if (input.activityType) {
        return {
          isError: true,
          error: new Error("Location search is temporarily unavailable."),
          refetch,
        };
      }
      return {
        data:
          options.enabled && input.location.kind === "nearby"
            ? { pages: [{ activities: [activity({ name: "Oakland Run", date: "2026-03-18" })] }] }
            : undefined,
        hasNextPage: true,
        fetchNextPage,
      };
    });
    render(<ActivitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Location" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Oakland" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up a place" }));
    fireEvent.click(screen.getByRole("button", { name: "Oakland, CA" }));
    expect(screen.getByRole("link", { name: "Oakland Run" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(fetchNextPage).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("combobox", { name: "Activity type" }), {
      target: { value: "running" },
    });
    expect(locationSearchQuery).toHaveBeenLastCalledWith(
      {
        location: { kind: "nearby", latitude: 37.8, longitude: -122.3 },
        activityType: "running",
        pageSize: 20,
      },
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByText("Location search is temporarily unavailable.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.queryByText("Near Oakland, CA")).toBeNull();
  });

  it("loads one photo only for visible cards without a map", () => {
    const photo = {
      id: "photo-1",
      url: "https://private.test/photo",
      width: 1200,
      height: 800,
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      sources: [],
    };
    mockImagesUseQuery.mockReturnValue({
      data: { images: [photo, { ...photo, id: "photo-2" }], coverage: [], acquisition: [] },
      error: null,
    });
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [activity(), activity({ id: "mapped-2", location: { kind: "processing" } })],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };
    render(<ActivitiesPage />);
    expect(screen.getAllByRole("img", { name: "Activity photo" })).toHaveLength(1);
    expect(mockImagesUseQuery).toHaveBeenCalledWith(
      { id: "activity-1" },
      expect.objectContaining({ enabled: true }),
    );
    expect(mockImagesUseQuery).toHaveBeenCalledWith(
      { id: "mapped-2" },
      expect.objectContaining({ enabled: false }),
    );
  });

  it("keeps a loaded photo and its card height when the card leaves the viewport", () => {
    let visibilityChanged: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          visibilityChanged = callback;
        }
        observe() {
          visibilityChanged?.([{ isIntersecting: true }]);
        }
        disconnect() {}
      },
    );
    const photo = {
      id: "photo-1",
      url: "https://private.test/photo",
      width: 1200,
      height: 800,
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      sources: [],
    };
    mockImagesUseQuery.mockReturnValue({
      data: { images: [photo], coverage: [], acquisition: [] },
      error: null,
    });
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };
    render(<ActivitiesPage />);
    expect(screen.getByRole("img", { name: "Activity photo" })).toBeInTheDocument();
    act(() => visibilityChanged?.([{ isIntersecting: false }]));
    expect(screen.getByRole("img", { name: "Activity photo" })).toBeInTheDocument();
    expect(screen.getByTestId("activity-secondary-panel")).toBeInTheDocument();
    expect(mockImagesUseQuery).toHaveBeenLastCalledWith(
      { id: "activity-1" },
      expect.objectContaining({ enabled: false }),
    );
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

    render(<ActivitiesPage />);

    expect(processingStatusInput).toEqual({ datasets: ["activity"] });
    expect(screen.getByText("Recomputing activities", { selector: "span" })).toBeDefined();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });

  it("uses QueryStatePanel for loading state", () => {
    mockQuery = { data: undefined, isLoading: true, isError: false, error: null };

    render(<ActivitiesPage />);

    expect(screen.getByTestId("query-state-loading")).toBeDefined();
  });

  it("uses QueryStatePanel for empty state", () => {
    mockUpcomingQuery = { ...mockUpcomingQuery, data: [], isSuccess: true };
    render(<ActivitiesPage />);

    expect(screen.getByTestId("query-state-empty")).toBeDefined();
    expect(screen.getByText("No workouts in this date range.")).toBeDefined();
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

  it("polls pending maps until their location data is ready", () => {
    render(<ActivitiesPage />);
    const interval = weekListOptions?.refetchInterval;
    expect(interval).toBeTypeOf("function");
    expect(
      interval?.({
        state: { data: { days: [{ activities: [{ location: { kind: "processing" } }] }] } },
      }),
    ).toBe(3000);
    expect(
      interval?.({
        state: { data: { days: [{ activities: [{ location: { kind: "recorded_gps" } }] }] } },
      }),
    ).toBe(false);
    expect(interval?.({ state: { data: { days: [{ activities: [{ location: null }] }] } } })).toBe(
      false,
    );
    expect(interval?.({ state: {} })).toBe(false);
    const searchInterval = locationSearchQuery.mock.lastCall?.[1].refetchInterval;
    const readyPage = { activities: [{ location: { kind: "recorded_gps" } }] };
    const pendingPage = { activities: [{ location: { kind: "processing" } }] };
    expect(searchInterval?.({ state: { data: { pages: [readyPage, pendingPage] } } })).toBe(3000);
    expect(searchInterval?.({ state: { data: { pages: [readyPage] } } })).toBe(false);
    expect(searchInterval?.({ state: {} })).toBe(false);
  });

  it("keeps placeholder activity data visible during background refetch errors", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity({ name: "Cached Ride" })] }],
      isLoading: false,
      isError: true,
      error: new Error("Refetch failed"),
    };

    render(<ActivitiesPage />);

    expect(screen.getByText("Cached Ride")).toBeDefined();
    expect(screen.getByText("Refetch failed")).toBeDefined();
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
        totalDistanceState: { status: "available" },
        totalElevationGainM: 520,
        totalElevationState: { status: "available" },
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
    expect(screen.queryByText(/vs previous/)).toBeNull();
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

    render(<ActivitiesPage />);

    expect(screen.getByText("1 more vs previous 4 weeks")).toBeDefined();
    expect(screen.getByText("1h 30m less vs previous 4 weeks")).toBeDefined();
    expect(screen.getByText("No change vs previous 4 weeks")).toBeDefined();
    expect(
      screen.getByText("Comparison unavailable: Previous period: Elevation gain not recorded"),
    ).toBeDefined();
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

    const { rerender } = render(<ActivitiesPage />);

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
    rerender(<ActivitiesPage />);

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

    render(<ActivitiesPage />);

    expect(screen.getByText("12.5 km")).toBeDefined();
    expect(screen.getByText("180 m")).toBeDefined();
    expect(screen.getByText("2.5 km more vs previous 4 weeks")).toBeDefined();
    expect(screen.getByText("50 m more vs previous 4 weeks")).toBeDefined();
    expect(screen.getByText("Distance").parentElement).not.toHaveTextContent(/unavailable/);
    expect(screen.getByText("Elevation").parentElement).not.toHaveTextContent(/unavailable/);
  });

  it("passes selected filters to the activity list query", () => {
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

    render(<ActivitiesPage />);
    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "8-weeks" } });
    fireEvent.change(screen.getByLabelText("Activity type"), { target: { value: "running" } });

    expect(weekListInput).toEqual({
      weeks: 8,
      startDate: expect.any(String),
      endDate: expect.any(String),
      dateOrder: "newest",
      activityType: "running",
      page: 0,
      pageSize: 20,
    });
    expect(overviewInput).toEqual({
      weeks: 8,
      endDate: expect.any(String),
      activityType: "running",
    });
    const previousOverview = { activityTypes: ["running"] };
    expect(overviewOptions?.placeholderData?.(previousOverview)).toBe(previousOverview);
    const previousWeekList = [{ date: "2026-03-18", activities: [] }];
    expect(weekListOptions?.placeholderData?.(previousWeekList)).toBe(previousWeekList);
  });

  it("requests hidden activities when the show hidden toggle is enabled", () => {
    render(<ActivitiesPage />);
    fireEvent.click(screen.getByLabelText("Show hidden activities"));

    expect(weekListInput).toEqual({
      weeks: 1,
      startDate: expect.any(String),
      endDate: expect.any(String),
      dateOrder: "oldest",
      includeProviderAbsent: true,
      page: 0,
      pageSize: 20,
    });
  });

  it("renders a type icon when an activity has no location data", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    expect(screen.getByTestId("activity-type-icon")).toBeDefined();
    expect(screen.getByLabelText("Indoor Cycling activity")).toBeDefined();
  });

  it("renders a map snapshot when an activity includes location data", async () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              location: {
                kind: "recorded_gps",
                centroidLat: 37.7749,
                centroidLng: -122.4194,
                mapPreview,
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

    render(<ActivitiesPage />);

    await finishMapSnapshot();
    expect(screen.getByTestId("activity-map-snapshot")).toHaveAttribute(
      "src",
      "data:image/png;base64,map",
    );
    expect(screen.getByLabelText("Activity location map")).toBeDefined();
  });

  it("links a climbing source-point preview to its activity while retaining climbing metrics", async () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity({
              id: "climbing-1",
              name: "Afternoon climbing",
              activityType: "climbing",
              stats: [{ status: "available", label: "Climbs", value: "3" }],
              location: {
                kind: "climbing_source",
                mapPreview: { ...mapPreview, routePath: null },
                sourcePoints: [
                  {
                    x: 256,
                    y: 144,
                    location: {
                      coordinates: { latitude: 37, longitude: -122 },
                      scope: "area",
                      objectId: "area-1",
                      providerId: "mountain-project",
                      name: "North Wall",
                    },
                  },
                ],
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
    await finishMapSnapshot();
    expect(screen.getByTestId("activity-map-snapshot")).toHaveAttribute(
      "src",
      "data:image/png;base64,map",
    );
    const map = screen.getByRole("img", {
      name: /Climbing source locations.*North Wall.*Mountain Project/,
    });
    expect(screen.getByRole("link", { name: "Afternoon climbing" })).toHaveAttribute(
      "href",
      "/activity/climbing-1",
    );
    expect(screen.getByText("Climbs")).toBeDefined();
    expect(map.querySelectorAll("circle")).toHaveLength(1);
    expect(map.querySelector("path")).toBeNull();
  });

  it.each([false, true])(
    "keeps source details separate from the card action in selection mode %s",
    (selectMode) => {
      mockQuery = {
        data: [
          {
            date: "2026-03-18",
            activities: [
              activity({
                source: {
                  origin: {
                    status: "resolved",
                    memberActivityId: "00000000-0000-4000-8000-000000000001",
                    providerId: "garmin",
                    sourceName: "Garmin Edge 530",
                  },
                  primarySourceLabel: "Garmin Connect",
                  tree: branchingSourceTree,
                  sourceCount: 5,
                  overlapSummary: null,
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
      if (selectMode) fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
      const trigger = screen.getByRole("button", { name: "Garmin Connect Lineage" });
      expect(trigger.closest("a")).toBeNull();
      expect(trigger.parentElement?.closest("button")).toBeNull();
      fireEvent.click(trigger);
      if (selectMode) {
        expect(screen.getByRole("checkbox", { name: "Select Trainer Ride" })).not.toBeChecked();
      } else {
        expect(screen.getByRole("link", { name: "Trainer Ride" })).toHaveAttribute(
          "href",
          "/activity/activity-1",
        );
      }
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      if (selectMode) {
        fireEvent.click(screen.getByRole("checkbox", { name: "Select Trainer Ride" }));
        expect(screen.getByRole("checkbox", { name: "Select Trainer Ride" })).toBeChecked();
      }
    },
  );

  it("shows selection guidance while choosing activities", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);

    const selectButton = screen.getByRole("button", { name: "Select activities" });
    expect(selectButton).toHaveAccessibleDescription("Choose activities to merge or delete.");
    fireEvent.click(selectButton);
    expect(screen.getByText("Choose activities to merge or delete.")).toBeDefined();
  });

  it("associates each selection control with its own guidance", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(
      <>
        <ActivitiesPage />
        <ActivitiesPage />
      </>,
    );

    const selectionButtons = screen.getAllByRole("button", { name: "Select activities" });
    const guidanceIds = selectionButtons.map((button) => button.getAttribute("aria-describedby"));

    expect(guidanceIds[0]).toBeTruthy();
    expect(guidanceIds[1]).toBeTruthy();
    expect(guidanceIds[0]).not.toBe(guidanceIds[1]);
    for (const guidanceId of guidanceIds) {
      expect(document.getElementById(guidanceId ?? "")).toHaveTextContent(
        "Choose activities to merge or delete.",
      );
    }
  });

  it("exposes the selected activity count as an accessible status", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    expect(screen.getByRole("status")).toHaveTextContent("0 activities selected");
    fireEvent.click(screen.getByText("Trainer Ride"));

    expect(screen.getByRole("status")).toHaveTextContent("1 activity selected");
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("status").getAttribute("aria-atomic")).toBe("true");
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
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
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

  it("merges selected same-type activities after confirmation", async () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [activity(), activity({ id: "activity-2", name: "Second Ride" })],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };
    render(<ActivitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.click(screen.getByText("Second Ride"));
    fireEvent.click(screen.getByText("Merge"));
    expect(mergeMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Confirm Merge"));
    await waitFor(() => {
      expect(mergeMutate).toHaveBeenCalledWith({ ids: ["activity-1", "activity-2"] });
      expect(invalidateWeekList).toHaveBeenCalled();
      expect(invalidateActivityOverview).toHaveBeenCalled();
      expect(invalidateCalendarData).toHaveBeenCalled();
      expect(invalidateActivityList).toHaveBeenCalled();
    });
  });

  it("disables merge for a single or mixed-type selection", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: [
            activity(),
            activity({ id: "activity-2", name: "Run", activityType: "running" }),
          ],
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };
    render(<ActivitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    const merge = screen.getByRole("button", { name: "Merge" });
    expect(merge).toBeDisabled();
    fireEvent.click(screen.getByText("Trainer Ride"));
    expect(merge).toBeDisabled();
    fireEvent.click(screen.getByText("Run"));
    expect(screen.getByText("Select activities of one type to merge.")).toBeDefined();
    expect(merge).toBeDisabled();
  });

  it("hides deleted activities immediately after delete confirmation", async () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Confirm Delete"));

    await waitFor(() => {
      expect(bulkDeleteMutate).toHaveBeenCalledWith({ ids: ["activity-1"] });
      expect(screen.queryByText("Trainer Ride")).toBeNull();
    });
  });

  it("restores deleted activities when bulk delete fails", async () => {
    mockBulkDeleteShouldFail = true;
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByText("Confirm Delete"));

    await waitFor(() => {
      expect(bulkDeleteMutate).toHaveBeenCalledWith({ ids: ["activity-1"] });
      expect(screen.getByText("Trainer Ride")).toBeDefined();
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

    render(<ActivitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByText("Trainer Ride"));
    fireEvent.change(screen.getByLabelText("Activity type"), { target: { value: "running" } });

    expect(screen.queryByText("1 activity selected")).toBeNull();
    expect(screen.getByRole("button", { name: "Select activities" })).toBeDefined();
  });

  it("keeps cached cards and navigation after an uncached server page fails", async () => {
    liveQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let failPage = true;
    livePageFetch = async (input) => {
      if (input.page === 1 && failPage)
        throw new Error("Page two is unavailable. Retry the request.");
      return {
        days: [
          {
            date: "2026-03-18",
            activities: [activity({ name: input.page === 1 ? "Next Ride" : "Cached Ride" })],
          },
        ],
        totalCount: 21,
        page: input.page ?? 0,
        pageSize: 20,
      };
    };
    render(
      <QueryClientProvider client={liveQueryClient}>
        <ActivitiesPage />
      </QueryClientProvider>,
    );
    await screen.findByText("Cached Ride");
    fireEvent.click(screen.getByRole("button", { name: "Next activities page" }));
    await screen.findByText("Page two is unavailable. Retry the request.");
    expect(screen.getByText("Cached Ride")).toBeDefined();
    expect(screen.getByRole("navigation", { name: "activities pagination" })).toBeDefined();
    failPage = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Next Ride");
    expect(screen.queryByText("Page two is unavailable. Retry the request.")).toBeNull();
  });

  it("does not label another range's cached cards as the failed selected range", async () => {
    liveQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    livePageFetch = async (input) => {
      if (input.weeks === 8) throw new Error("Selected range is unavailable.");
      return {
        days: [{ date: "2026-03-18", activities: [activity({ name: "Previous Range Ride" })] }],
        totalCount: 1,
        page: 0,
        pageSize: 20,
      };
    };
    render(
      <QueryClientProvider client={liveQueryClient}>
        <ActivitiesPage />
      </QueryClientProvider>,
    );
    await screen.findByText("Previous Range Ride");
    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "8-weeks" } });
    await screen.findByText("Selected range is unavailable.");
    expect(screen.queryByText("Previous Range Ride")).toBeNull();
  });

  it("keeps selected activity types across server pages when checking merge eligibility", () => {
    mockQuery = {
      data: [
        {
          date: "2026-03-18",
          activities: Array.from({ length: 21 }, (_, index) =>
            activity({
              id: `ride-${index}`,
              name: `Ride ${index}`,
              activityType: index === 20 ? "running" : "cycling",
            }),
          ),
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };
    render(<ActivitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
    fireEvent.click(screen.getByText("Ride 0"));
    fireEvent.click(screen.getByRole("button", { name: "Next activities page" }));
    fireEvent.click(screen.getByText("Ride 20"));
    expect(screen.getByRole("button", { name: "Merge" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Select activities of one type to merge.")).toBeDefined();
    expect(overviewInput).toEqual({ weeks: 1, endDate: expect.any(String) });
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

    render(<ActivitiesPage />);

    expect(screen.getByText("Ride 1")).toBeDefined();
    expect(screen.queryByText("Ride 21")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next activities page" }));

    expect(weekListInput).toMatchObject({ page: 1, pageSize: 20 });
    expect(screen.queryByText("Ride 1")).toBeNull();
    expect(screen.getByText("Ride 21")).toBeDefined();
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
    expect(
      screen.getByText(
        "Choose visible activities to merge or delete, or hidden activities to restore.",
      ),
    ).toBeDefined();
    expect(screen.getByText("Removed")).toBeDefined();
    expect(screen.getByText(/Removed from Strava/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
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

  it("shows the server list failure when there is no cached activity history", () => {
    const error = new Error("Activity history is unavailable. Try again shortly.");
    mockQuery = { data: undefined, isLoading: false, isError: true, error };

    render(<ActivitiesPage />);

    expect(screen.getByText(error.message)).toBeTruthy();
    expect(screen.queryByTestId("activity-card-grid")).toBeNull();
  });

  it("keeps cached activity cards visible during an activity-history refresh failure", () => {
    const error = new Error("Activity history refresh failed");
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: true,
      error,
    };

    render(<ActivitiesPage />);

    expect(screen.getByText("Trainer Ride")).toBeTruthy();
    expect(screen.getByText(error.message)).toBeTruthy();
  });

  it("keeps the activity history available while overview totals are loading", () => {
    mockQuery = {
      data: [{ date: "2026-03-18", activities: [activity()] }],
      isLoading: false,
      isError: false,
      error: null,
    };
    mockOverviewQuery = { data: undefined, isLoading: true, isError: false, error: null };

    render(<ActivitiesPage />);

    expect(screen.getByText("Trainer Ride")).toBeTruthy();
    expect(screen.getAllByTestId("query-state-loading")).toHaveLength(1);
  });

  it("uses the hidden-activity empty state after the user includes provider-absent activities", () => {
    mockUpcomingQuery = { ...mockUpcomingQuery, data: [], isSuccess: true };
    render(<ActivitiesPage />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show hidden activities" }));

    expect(screen.getByText(/No workouts in this date range/)).toBeTruthy();
    expect(weekListInput).toMatchObject({ includeProviderAbsent: true });
  });

  describe("workout calendar agenda", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(new Date(2026, 10, 24, 12));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("merges a mixed this-week day with Planned and Completed labels under Workout calendar", () => {
      mockQuery = {
        data: [
          {
            date: "2026-11-24",
            activities: [
              activity({
                id: "ride-1",
                name: "Morning ride",
                activityType: "road_cycling",
                startedAt: "2026-11-24T15:08:00.000Z",
                source: {
                  tree: { primary: null, otherSources: [] },
                  origin: { status: "unresolved", candidateMemberActivityIds: [] },
                  primarySourceLabel: "Garmin Connect",
                  sourceCount: 1,
                  overlapSummary: null,
                },
              }),
            ],
          },
        ],
        isLoading: false,
        isError: false,
        isSuccess: true,
        error: null,
      };
      mockUpcomingQuery = {
        ...mockUpcomingQuery,
        isSuccess: true,
        data: [
          {
            date: "2026-11-24",
            workouts: [
              {
                id: "plan-1",
                providerId: "intervals.icu",
                title: "Tempo intervals",
                description: null,
                sportType: "cycling",
                startTime: "07:00",
                steps: [],
              },
            ],
          },
          {
            date: "2026-11-26",
            workouts: [
              {
                id: "plan-2",
                providerId: "intervals.icu",
                title: "Easy endurance",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
              },
            ],
          },
        ],
      };

      render(<ActivitiesPage />);

      expect(screen.getByRole("heading", { name: "Workout calendar" })).toBeDefined();
      expect(screen.getByText(/Nov 23.*29, 2026/)).toBeDefined();
      expect(screen.getByLabelText("Date range")).toHaveProperty("value", "this-week");
      expect(weekListInput).toMatchObject({
        startDate: "2026-11-23",
        endDate: "2026-11-29",
        weeks: 1,
        dateOrder: "oldest",
        page: 0,
        pageSize: 20,
      });
      expect(upcomingQueryInput).toEqual({
        dateRange: { startDate: "2026-11-23", endDate: "2026-11-29" },
      });
      expect(screen.getByText("Tempo intervals")).toBeDefined();
      expect(screen.getByText("Morning ride")).toBeDefined();
      expect(screen.getByText("Easy endurance")).toBeDefined();
      expect(screen.getAllByText("Planned").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Completed").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/Intervals\.icu/).length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByRole("heading", { name: "Upcoming workouts" })).toBeNull();
      expect(screen.getAllByText("No workouts").length).toBeGreaterThanOrEqual(1);
    });

    it("includes recorded search in shared connection retry while Next 90 days stays selected", () => {
      const searchRefetch = vi.fn();
      const processingRefetch = vi.fn();
      const message = "We couldn't reach the server. Check your connection and try again.";
      titleSearchQuery.mockReturnValue({
        data: undefined,
        isError: true,
        error: new Error(message),
        isFetching: false,
        hasNextPage: false,
        refetch: searchRefetch,
      });
      mockDataHealthQuery = {
        ...mockDataHealthQuery,
        error: new Error(message),
        refetch: processingRefetch,
      };

      render(<ActivitiesPage />);
      fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "next-90-days" } });
      fireEvent.change(screen.getByRole("searchbox", { name: "Search activity titles" }), {
        target: { value: "Ride" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Search" }));

      expect(screen.getAllByText(message)).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(searchRefetch).toHaveBeenCalledOnce();
      expect(processingRefetch).toHaveBeenCalledOnce();
    });

    it("shows a future-only range without a recorded overview and keeps known sports", () => {
      const overviewData = mockOverviewQuery.data;
      if (overviewData == null) throw new Error("expected overview fixture");
      mockOverviewQuery = {
        ...mockOverviewQuery,
        data: {
          ...overviewData,
          activityTypes: ["cycling", "running"],
        },
      };
      const { rerender } = render(<ActivitiesPage />);
      fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "next-90-days" } });
      mockOverviewQuery = { ...mockOverviewQuery, data: undefined };
      rerender(<ActivitiesPage />);

      expect(weekListOptions?.enabled).toBe(false);
      expect(overviewOptions?.enabled).toBe(false);
      expect(upcomingQueryInput).toEqual({
        dateRange: { startDate: "2026-11-25", endDate: "2027-02-22" },
      });
      fireEvent.change(screen.getByLabelText("Activity type"), { target: { value: "cycling" } });
      expect(upcomingQueryInput).toMatchObject({ activityType: "cycling" });
      expect(screen.getByRole("option", { name: "Cycling" })).toBeDefined();
    });

    it("does not show empty weekday copy while a feed is still in flight", () => {
      mockQuery = {
        data: [{ date: "2026-11-24", activities: [activity({ name: "Morning ride" })] }],
        isLoading: false,
        isError: false,
        isSuccess: true,
        error: null,
      };
      mockUpcomingQuery = {
        ...mockUpcomingQuery,
        data: undefined,
        isLoading: true,
        isSuccess: false,
        isError: false,
        error: null,
      };

      render(<ActivitiesPage />);

      expect(screen.getByText("Morning ride")).toBeDefined();
      expect(screen.queryByText("No workouts")).toBeNull();
      expect(screen.queryByText("No workouts in this date range.")).toBeNull();
    });

    it("shows plans when the completed feed fails before the first load", () => {
      mockQuery = {
        data: undefined,
        isLoading: false,
        isError: true,
        isSuccess: false,
        error: new Error("Activity history is unavailable."),
      };
      mockUpcomingQuery = {
        ...mockUpcomingQuery,
        data: [
          {
            date: "2026-11-26",
            workouts: [
              {
                id: "plan-2",
                providerId: "intervals.icu",
                title: "Easy endurance",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
              },
            ],
          },
        ],
        isSuccess: true,
      };

      render(<ActivitiesPage />);

      expect(upcomingQueryInput).toEqual({
        dateRange: { startDate: "2026-11-23", endDate: "2026-11-29" },
      });
      expect(screen.getByText("Easy endurance")).toBeDefined();
      expect(screen.getByText("Activity history is unavailable.")).toBeDefined();
      expect(screen.queryByText("No workouts in this date range.")).toBeNull();
    });

    it("does not mix planned rows across a date-range change", () => {
      mockUpcomingQuery = {
        ...mockUpcomingQuery,
        data: [
          {
            date: "2026-11-26",
            workouts: [
              {
                id: "this-week-plan",
                providerId: "intervals.icu",
                title: "This week plan",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
              },
            ],
          },
        ],
        isSuccess: true,
      };
      render(<ActivitiesPage />);
      expect(screen.getByText("This week plan")).toBeDefined();

      mockUpcomingQuery = {
        ...mockUpcomingQuery,
        data: [
          {
            date: "2026-10-30",
            workouts: [
              {
                id: "four-week-plan",
                providerId: "intervals.icu",
                title: "Four week plan",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
              },
            ],
          },
        ],
        isSuccess: true,
      };
      fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "4-weeks" } });

      expect(upcomingQueryInput).toEqual({
        dateRange: { startDate: "2026-10-28", endDate: "2026-11-24" },
      });
      expect(upcomingOptions?.placeholderData).toBeUndefined();
      expect(screen.getByText("Four week plan")).toBeDefined();
      expect(screen.queryByText("This week plan")).toBeNull();
    });

    it("keeps showing-page planned ownership while same-range paging uses placeholder data", () => {
      mockQuery = {
        data: [
          {
            date: "2026-11-20",
            activities: [
              activity({ id: "older", name: "Older ride", startedAt: "2026-11-20T15:00:00.000Z" }),
            ],
          },
        ],
        isLoading: false,
        isError: false,
        isSuccess: true,
        isPlaceholderData: false,
        page: 0,
        plannedWindow: { startDate: "2026-11-20", endDate: "2026-11-24" },
        totalCount: 40,
        error: null,
      };
      mockUpcomingQuery = {
        ...mockUpcomingQuery,
        isSuccess: true,
        data: [
          {
            date: "2026-11-22",
            workouts: [
              {
                id: "owned-plan",
                providerId: "intervals.icu",
                title: "Owned page plan",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
              },
            ],
          },
          {
            date: "2026-11-28",
            workouts: [
              {
                id: "outside-plan",
                providerId: "intervals.icu",
                title: "Outside page plan",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
              },
            ],
          },
        ],
      };

      const { rerender } = render(<ActivitiesPage />);
      fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "4-weeks" } });
      expect(weekListInput).toMatchObject({
        startDate: "2026-10-28",
        endDate: "2026-11-24",
        page: 0,
      });
      expect(screen.getByText("Older ride")).toBeDefined();
      expect(screen.getByText("Owned page plan")).toBeDefined();

      // Same-range soft page: keep prior page payload as placeholder while requesting page 1.
      mockQuery = { ...mockQuery, isPlaceholderData: true, page: 0 };
      fireEvent.click(screen.getByRole("button", { name: "Next activities page" }));

      expect(weekListInput).toMatchObject({ page: 1 });
      expect(screen.getByText("Older ride")).toBeDefined();
      expect(screen.getByText("Owned page plan")).toBeDefined();
      expect(screen.queryByText("Outside page plan")).toBeNull();

      mockQuery = {
        data: [
          {
            date: "2026-11-18",
            activities: [
              ...Array.from({ length: 20 }, (_, index) =>
                activity({
                  id: `pad-${index}`,
                  name: `Pad ride ${index}`,
                  startedAt: "2026-11-19T15:00:00.000Z",
                }),
              ),
              activity({
                id: "newer-page",
                name: "Next page ride",
                startedAt: "2026-11-18T15:00:00.000Z",
              }),
            ],
          },
        ],
        isLoading: false,
        isError: false,
        isSuccess: true,
        isPlaceholderData: false,
        page: 1,
        plannedWindow: { startDate: "2026-11-18", endDate: "2026-11-19" },
        totalCount: 40,
        error: null,
      };
      mockUpcomingQuery = {
        ...mockUpcomingQuery,
        isSuccess: true,
        data: [
          {
            date: "2026-11-18",
            workouts: [
              {
                id: "next-page-plan",
                providerId: "intervals.icu",
                title: "Next page plan",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
              },
            ],
          },
          {
            date: "2026-11-22",
            workouts: [
              {
                id: "owned-plan",
                providerId: "intervals.icu",
                title: "Owned page plan",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
              },
            ],
          },
        ],
      };
      rerender(<ActivitiesPage />);

      expect(screen.getByText("Next page ride")).toBeDefined();
      expect(screen.getByText("Next page plan")).toBeDefined();
      expect(screen.queryByText("Older ride")).toBeNull();
      expect(screen.queryByText("Owned page plan")).toBeNull();
    });

    it("resets page and selection when the agenda span rolls into a new week", async () => {
      vi.setSystemTime(new Date(2026, 10, 29, 23, 59, 58));
      mockQuery = {
        data: [
          {
            date: "2026-11-29",
            activities: [
              activity({
                id: "sunday-ride",
                name: "Sunday ride",
                startedAt: "2026-11-29T18:00:00.000Z",
              }),
            ],
          },
        ],
        isLoading: false,
        isError: false,
        isSuccess: true,
        totalCount: 40,
        error: null,
      };
      mockUpcomingQuery = { ...mockUpcomingQuery, data: [], isSuccess: true };

      render(<ActivitiesPage />);
      expect(weekListInput).toMatchObject({
        startDate: "2026-11-23",
        endDate: "2026-11-29",
        page: 0,
      });
      fireEvent.click(screen.getByRole("button", { name: "Select activities" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select Sunday ride" }));
      expect(screen.getByRole("checkbox", { name: "Select Sunday ride" })).toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: "Next activities page" }));
      expect(weekListInput).toMatchObject({ page: 1 });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });

      expect(weekListInput).toMatchObject({
        startDate: "2026-11-30",
        endDate: "2026-12-06",
        page: 0,
      });
      expect(screen.getByRole("button", { name: "Select activities" })).toBeDefined();
      expect(screen.queryByRole("checkbox", { name: "Select Sunday ride" })).toBeNull();
    });

    it("keeps cached plans when a previous-range completed placeholder is ignored", () => {
      mockQuery = {
        data: [
          {
            date: "2026-11-10",
            activities: [activity({ name: "Historical ride" })],
          },
        ],
        isLoading: false,
        isError: false,
        isSuccess: true,
        error: null,
      };
      mockUpcomingQuery = { ...mockUpcomingQuery, data: [], isSuccess: true };

      const { rerender } = render(<ActivitiesPage />);
      fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "4-weeks" } });
      expect(screen.getByText("Historical ride")).toBeDefined();

      mockQuery = { ...mockQuery, isPlaceholderData: true, isSuccess: true };
      mockUpcomingQuery = {
        ...mockUpcomingQuery,
        isSuccess: true,
        data: [
          {
            date: "2026-11-26",
            workouts: [
              {
                id: "this-week-plan",
                providerId: "intervals.icu",
                title: "This week plan",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
              },
            ],
          },
        ],
      };
      fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "this-week" } });
      rerender(<ActivitiesPage />);

      expect(screen.queryByText("Historical ride")).toBeNull();
      expect(screen.getByText("This week plan")).toBeDefined();
      expect(screen.queryAllByText("No workouts")).toHaveLength(0);
      expect(screen.queryByText("No workouts in this date range.")).toBeNull();
    });

    it.each([
      {
        label: "completed",
        errorText: "Activity history is unavailable.",
        setup: () => {
          const completedRefetch = vi.fn();
          mockQuery = {
            data: undefined,
            isLoading: false,
            isError: true,
            isSuccess: false,
            error: new Error("Activity history is unavailable."),
            refetch: completedRefetch,
          };
          mockUpcomingQuery = {
            ...mockUpcomingQuery,
            data: undefined,
            isLoading: true,
            isFetching: true,
            isSuccess: false,
            isError: false,
            error: null,
            refetch: vi.fn(),
          };
          return completedRefetch;
        },
      },
      {
        label: "planned",
        errorText: "Schedule is temporarily unavailable.",
        setup: () => {
          const plannedRefetch = vi.fn();
          mockQuery = {
            data: undefined,
            isLoading: true,
            isError: false,
            isSuccess: false,
            error: null,
            refetch: vi.fn(),
          };
          mockUpcomingQuery = {
            ...mockUpcomingQuery,
            data: undefined,
            isLoading: false,
            isFetching: false,
            isSuccess: false,
            isError: true,
            error: new Error("Schedule is temporarily unavailable."),
            refetch: plannedRefetch,
          };
          return plannedRefetch;
        },
      },
    ] as const)(
      "keeps a $label feed error visible while the other feed is still loading",
      ({ errorText, setup }) => {
        const retry = setup();
        render(<ActivitiesPage />);

        expect(screen.getByText(errorText)).toBeDefined();
        expect(screen.getByTestId("query-state-loading")).toBeDefined();
        expect(screen.queryByText("No workouts in this date range.")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(retry).toHaveBeenCalledOnce();
      },
    );

    it("hides range-level empty when the visible page is empty but the range still has activities", () => {
      mockQuery = {
        data: [],
        isLoading: false,
        isError: false,
        isSuccess: true,
        totalCount: 40,
        page: 1,
        error: null,
      };
      mockUpcomingQuery = { ...mockUpcomingQuery, data: [], isSuccess: true };

      render(<ActivitiesPage />);

      expect(screen.queryByText("No workouts in this date range.")).toBeNull();
      expect(screen.getByRole("navigation", { name: "activities pagination" })).toBeDefined();
      expect(screen.getByRole("button", { name: "Previous activities page" })).toBeDefined();
    });

    it("keeps completed totals when the planned feed fails", () => {
      mockQuery = {
        data: [{ date: "2026-11-24", activities: [activity({ name: "Morning ride" })] }],
        isLoading: false,
        isError: false,
        error: null,
      };
      mockOverviewQuery = {
        ...mockOverviewQuery,
        data: {
          activityCount: 1,
          totalMinutes: 52,
          totalDistanceMeters: 0,
          totalDistanceState: { status: "available" },
          totalElevationGainM: 0,
          totalElevationState: { status: "available" },
          activityTypes: ["road_cycling"],
        },
      };
      mockUpcomingQuery = {
        ...mockUpcomingQuery,
        data: undefined,
        isError: true,
        error: new Error("Schedule is temporarily unavailable."),
        refetch: vi.fn(),
      };

      render(<ActivitiesPage />);

      expect(screen.getByText("Morning ride")).toBeDefined();
      expect(screen.getByText("1")).toBeDefined();
      expect(screen.getByText("Schedule is temporarily unavailable.")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(mockUpcomingQuery.refetch).toHaveBeenCalledOnce();
    });

    it("retains planned rows during a same-range planned refetch", () => {
      const planned = [
        {
          date: "2026-11-26",
          workouts: [
            {
              id: "plan-2",
              providerId: "intervals.icu",
              title: "Easy endurance",
              description: null,
              sportType: "cycling",
              startTime: null,
              steps: [],
            },
          ],
        },
      ];
      mockUpcomingQuery = {
        ...mockUpcomingQuery,
        data: planned,
        isSuccess: true,
        isFetching: true,
        isPlaceholderData: false,
      };

      render(<ActivitiesPage />);

      expect(screen.getByText("Easy endurance")).toBeDefined();
      expect(upcomingOptions?.placeholderData).toBeUndefined();
    });

    it("shows Snapshot with the import date for a disconnected plan", () => {
      mockUpcomingQuery = {
        ...mockUpcomingQuery,
        data: [
          {
            date: "2026-11-26",
            workouts: [
              {
                id: "snap-1",
                providerId: "intervals.icu",
                title: "Easy endurance",
                description: null,
                sportType: "cycling",
                startTime: null,
                steps: [],
                snapshotImportedAt: "2026-11-20T12:00:00.000Z",
              },
            ],
          },
        ],
      };

      render(<ActivitiesPage />);

      expect(screen.getByText(/Snapshot/)).toBeDefined();
      expect(screen.getByText(/Nov 20, 2026/)).toBeDefined();
    });
  });
});
