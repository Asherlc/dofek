import { QueryClient, useQuery as useLiveQuery } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import {
  activityListQuery,
  emptyActivityOverviewQuery,
  type MockOverviewQuery,
  type MockQuery,
  type MockWeekListQuery,
  type WeekListQueryOptions,
} from "./activities-test-helpers";

const queryFixtureClient = new QueryClient();
export const routerPush = vi.fn();
export const mockImagesQuery = vi.fn();
export const titleSearchQuery = vi.fn();
export const placeLookupQuery = vi.fn();
export const locationSearchQuery = vi.fn();
export const activityMocks: {
  mockQuery: MockWeekListQuery;
  liveQueryClient: QueryClient | undefined;
  livePageFetch:
    | ((input: { page?: number; pageSize?: number; weeks?: number }) => Promise<unknown>)
    | undefined;
  mockCalendarQuery: MockQuery;
  mockOverviewQuery: MockOverviewQuery;
  mockUpcomingQuery: {
    data: unknown;
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
    isFetching: boolean;
    refetch: CallableVitestMock;
  };
  upcomingQueryInput: unknown;
  weekListInput: unknown;
  weekListOptions: WeekListQueryOptions | undefined;
  calendarDataInput: unknown;
  calendarDataOptions: { placeholderData?: (previousData: unknown) => unknown } | undefined;
  overviewInput: unknown;
  overviewOptions: { placeholderData?: (previousData: unknown) => unknown } | undefined;
  bulkDeleteMutateAsync: CallableVitestMock;
  mergeMutateAsync: CallableVitestMock;
  mockMergeShouldFail: boolean;
  invalidateWeekList: CallableVitestMock;
  invalidateActivityOverview: CallableVitestMock;
  invalidateUpcoming: CallableVitestMock;
  invalidateCalendarData: CallableVitestMock;
  invalidateActivityList: CallableVitestMock;
  resetTrainingProgressionStrength: CallableVitestMock;
  resetTrainingProgressionCycling: CallableVitestMock;
  invalidateDataHealth: CallableVitestMock;
  mockDataHealthQuery: {
    data: unknown;
    isLoading: boolean;
    error: Error | null;
    refetch?: CallableVitestMock;
  };
  processingStatusInput: unknown;
} = {
  mockQuery: activityListQuery([]),
  liveQueryClient: undefined,
  livePageFetch: undefined,
  mockCalendarQuery: { data: [], isLoading: false, isError: false, error: null },
  mockOverviewQuery: emptyActivityOverviewQuery(),
  mockUpcomingQuery: {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  },
  upcomingQueryInput: undefined,
  weekListInput: undefined,
  weekListOptions: undefined,
  calendarDataInput: undefined,
  calendarDataOptions: undefined,
  overviewInput: undefined,
  overviewOptions: undefined,
  bulkDeleteMutateAsync: vi.fn(),
  mergeMutateAsync: vi.fn(),
  mockMergeShouldFail: false,
  invalidateWeekList: vi.fn(),
  invalidateActivityOverview: vi.fn(),
  invalidateUpcoming: vi.fn(),
  invalidateCalendarData: vi.fn(),
  invalidateActivityList: vi.fn(),
  resetTrainingProgressionStrength: vi.fn(),
  resetTrainingProgressionCycling: vi.fn(),
  invalidateDataHealth: vi.fn(),
  mockDataHealthQuery: { data: undefined, isLoading: false, error: null },
  processingStatusInput: undefined,
};

export function mockActivityImages(images: unknown[]): void {
  mockImagesQuery.mockReturnValue({
    data: { images, coverage: [], acquisition: [] },
    error: null,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  });
}

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: routerPush }),
  Link: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

vi.mock("../../lib/trpc", () => ({
  trpc: {
    activityLocation: {
      places: { useQuery: placeLookupQuery },
      search: { useInfiniteQuery: locationSearchQuery },
    },
    calendar: {
      searchActivities: { useInfiniteQuery: titleSearchQuery },
      weekListV2: {
        useQuery: (
          input: { page?: number; pageSize?: number },
          options: WeekListQueryOptions | undefined,
        ) => {
          activityMocks.weekListInput = input;
          activityMocks.weekListOptions = options;
          const liveQuery = useLiveQuery(
            {
              queryKey: ["activities", input],
              queryFn: () => activityMocks.livePageFetch?.(input),
              placeholderData: options?.placeholderData,
              retry: false,
              enabled: Boolean(activityMocks.livePageFetch),
            },
            activityMocks.liveQueryClient ?? queryFixtureClient,
          );
          if (activityMocks.livePageFetch) return liveQuery;
          const page = input.page ?? 0;
          const pageSize = input.pageSize ?? 20;
          let offset = 0;
          const days = activityMocks.mockQuery.data
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
          return {
            ...activityMocks.mockQuery,
            data: days ? { days, totalCount: offset, page, pageSize } : undefined,
          };
        },
      },
      activityOverview: {
        useQuery: (
          input: unknown,
          options: { placeholderData?: (previousData: unknown) => unknown } | undefined,
        ) => {
          activityMocks.overviewInput = input;
          activityMocks.overviewOptions = options;
          return activityMocks.mockOverviewQuery;
        },
      },
      calendarData: {
        useQuery: (
          input: unknown,
          options: { placeholderData?: (previousData: unknown) => unknown } | undefined,
        ) => {
          activityMocks.calendarDataInput = input;
          activityMocks.calendarDataOptions = options;
          return activityMocks.mockCalendarQuery;
        },
      },
      upcomingWorkouts: {
        useQuery: (input: unknown) => {
          activityMocks.upcomingQueryInput = input;
          return activityMocks.mockUpcomingQuery;
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
          mutate: activityMocks.mergeMutateAsync.mockImplementation(async () => {
            if (activityMocks.mockMergeShouldFail) options?.onError?.(new Error("Merge failed"));
            else await options?.onSuccess?.();
          }),
          isPending: false,
          error: null,
        }),
      },
      bulkDelete: {
        useMutation: (options?: { onSuccess?: () => Promise<void> | void }) => ({
          mutate: activityMocks.bulkDeleteMutateAsync.mockImplementation(async () => {
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
          activityMocks.processingStatusInput = input;
          return activityMocks.mockDataHealthQuery;
        },
      },
      dismiss: { useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }) },
    },
    useUtils: () => ({
      activityLocation: { search: { invalidate: vi.fn() } },
      trainingProgression: {
        strength: { reset: activityMocks.resetTrainingProgressionStrength },
        cycling: { reset: activityMocks.resetTrainingProgressionCycling },
      },
      calendar: {
        weekListV2: {
          invalidate: activityMocks.invalidateWeekList,
          getData: (input: unknown) =>
            activityMocks.liveQueryClient?.getQueryData(["activities", input]),
        },
        activityOverview: { invalidate: activityMocks.invalidateActivityOverview },
        upcomingWorkouts: { invalidate: activityMocks.invalidateUpcoming },
        searchActivities: { invalidate: vi.fn() },
        calendarData: { invalidate: activityMocks.invalidateCalendarData },
      },
      activity: {
        list: { invalidate: activityMocks.invalidateActivityList },
      },
      processing: {
        status: { invalidate: activityMocks.invalidateDataHealth },
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

afterEach(() => vi.useRealTimers());

beforeEach(() => {
  queryFixtureClient.clear();
  activityMocks.liveQueryClient?.clear();
  activityMocks.liveQueryClient = undefined;
  activityMocks.livePageFetch = undefined;
  mockImagesQuery.mockReset();
  mockImagesQuery.mockReturnValue({
    data: { images: [], coverage: [], acquisition: [] },
    error: null,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  });
  activityMocks.mockQuery = { data: [], isLoading: false, isError: false, error: null };
  titleSearchQuery.mockReset();
  titleSearchQuery.mockReturnValue({ data: undefined, isPending: false });
  placeLookupQuery.mockReset();
  placeLookupQuery.mockReturnValue({});
  locationSearchQuery.mockReset();
  locationSearchQuery.mockReturnValue({});
  activityMocks.mockCalendarQuery = { data: [], isLoading: false, isError: false, error: null };
  activityMocks.mockOverviewQuery = emptyActivityOverviewQuery();
  activityMocks.mockUpcomingQuery = {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  };
  activityMocks.upcomingQueryInput = undefined;
  activityMocks.invalidateUpcoming = vi.fn();
  activityMocks.weekListInput = undefined;
  activityMocks.calendarDataInput = undefined;
  activityMocks.calendarDataOptions = undefined;
  activityMocks.overviewInput = undefined;
  activityMocks.overviewOptions = undefined;
  activityMocks.bulkDeleteMutateAsync = vi.fn();
  activityMocks.mergeMutateAsync = vi.fn();
  activityMocks.mockMergeShouldFail = false;
  activityMocks.invalidateWeekList = vi.fn();
  activityMocks.invalidateActivityOverview = vi.fn();
  activityMocks.invalidateCalendarData = vi.fn();
  activityMocks.invalidateActivityList = vi.fn();
  activityMocks.resetTrainingProgressionStrength = vi.fn();
  activityMocks.resetTrainingProgressionCycling = vi.fn();
  activityMocks.mockDataHealthQuery = { data: undefined, isLoading: false, error: null };
  activityMocks.processingStatusInput = undefined;
  activityMocks.invalidateDataHealth = vi.fn();
  routerPush.mockReset();
  vi.restoreAllMocks();
});
