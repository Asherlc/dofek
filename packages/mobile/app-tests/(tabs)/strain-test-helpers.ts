import { vi } from "vitest";
import { defaultMockTrainingData } from "../../app-fixtures/(tabs)/strain-test-helpers";
import { climbingStrengthsFixture } from "../../components/climbing-strengths-fixtures";
import { runningData } from "../../components/running-training-test-helpers";

export const mockStrengthsState: {
  data: unknown;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
} = { data: undefined, isLoading: false, isFetching: false, isError: false, error: null };
export const mockCaptureException = vi.fn();
export const mockRouterPush = vi.fn();
export const mockTrainingInvalidate = vi.fn();
export const mockLocationMapInvalidate = vi.fn();
export const mockHrZonesInvalidate = vi.fn();
export const mockPolarizationInvalidate = vi.fn();
export const mockProcessingStatusInvalidate = vi.fn();
export const mockRunningInvalidate = vi.fn();
export const mockRouteComparisonInvalidate = vi.fn();
export const mockRouteComparisonQuery = vi.fn();
export const mockVolumeIncreaseQuery = vi.fn();
export const mockVolumeIncreaseInvalidate = vi.fn();
export const mockDemonstratedGradeQuery = vi.fn();
export const mockDemonstratedGradeInvalidate = vi.fn();
export const mockAttemptIncreaseQuery = vi.fn();
export const mockAttemptIncreaseInvalidate = vi.fn();
type MockRangeQueryOptions = {
  enabled?: boolean;
  refetchInterval?: (query: {
    state: { data?: { enrichmentPending?: boolean } };
  }) => number | false;
  placeholderData?: (previousData: unknown) => unknown;
};
type MockRangeQueryName =
  | "running"
  | "training"
  | "hrZones"
  | "polarization"
  | "locationMap"
  | "strengths"
  | "climbingVolume"
  | "strengthVolume"
  | "sportVolume";

type MockRangeQueryCalls = Record<
  MockRangeQueryName,
  Array<{ input: { days: number | null; endDate?: string }; options: MockRangeQueryOptions }>
>;

function emptyRangeQueryCalls(): MockRangeQueryCalls {
  return {
    running: [],
    training: [],
    locationMap: [],
    strengths: [],
    hrZones: [],
    polarization: [],
    climbingVolume: [],
    strengthVolume: [],
    sportVolume: [],
  };
}

export const mockQueryState: {
  todayQueryDate: string;
  runningData: unknown;
  runningLoading: boolean;
  runningError: Error | null;
  focused: boolean;
  refreshInvalidate: (() => Promise<void> | void) | null | undefined;
  trainingDataDays: number;
  rangeQueryCalls: MockRangeQueryCalls;
  timeRangePreference: { days: number; isHydrated: boolean; setDays: ReturnType<typeof vi.fn> };
} = {
  todayQueryDate: "2026-03-28",
  runningData: undefined,
  runningLoading: false,
  runningError: null,
  focused: true,
  refreshInvalidate: undefined,
  trainingDataDays: 90,
  rangeQueryCalls: emptyRangeQueryCalls(),
  timeRangePreference: { days: 90, isHydrated: true, setDays: vi.fn() },
};

type MockTrainingData = Record<string, unknown>;
type MockTrainingState = {
  data: MockTrainingData | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
};

export const mockTrainingState: MockTrainingState = {
  data: undefined,
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null,
};

export const mockHrZonesState: MockTrainingState = {
  data: undefined,
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null,
};

const mockLocationMapState: MockTrainingState = {
  data: { bounds: null, nodes: [] },
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null,
};

export const mockPolarizationState: MockTrainingState = {
  data: undefined,
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null,
};

function resetMockTrainingState() {
  mockQueryState.todayQueryDate = "2026-03-28";
  Object.assign(mockStrengthsState, {
    data: structuredClone(climbingStrengthsFixture),
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
  });
  mockCaptureException.mockClear();
  mockTrainingState.data = structuredClone(defaultMockTrainingData());
  mockTrainingState.isLoading = false;
  mockTrainingState.isFetching = false;
  mockTrainingState.isError = false;
  mockTrainingState.error = null;
  for (const state of [mockHrZonesState, mockPolarizationState]) {
    state.data = undefined;
    state.isLoading = false;
    state.isFetching = false;
    state.isError = false;
    state.error = null;
  }
  Object.assign(mockLocationMapState, {
    data: { bounds: null, nodes: [] },
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
  });
}

vi.mock("expo-router", () => ({
  useIsFocused: () => mockQueryState.focused,
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("../../lib/trpc", () => ({
  trpc: {
    running: {
      dynamicsV2: {
        useQuery: (input: { days: number }, options: MockRangeQueryOptions) => {
          mockQueryState.rangeQueryCalls.running.push({ input, options });
          return {
            data: mockQueryState.runningData,
            isLoading: mockQueryState.runningLoading,
            isError: mockQueryState.runningError !== null,
            error: mockQueryState.runningError,
            refetch: vi.fn(),
          };
        },
      },
    },
    hiking: { activityComparison: { useQuery: mockRouteComparisonQuery } },
    climbing: {
      attemptIncrease: { useQuery: mockAttemptIncreaseQuery },
      volumeIncrease: { useQuery: mockVolumeIncreaseQuery },
      volumeOverTime: {
        useQuery: (input: { days: number }, options: MockRangeQueryOptions) => {
          mockQueryState.rangeQueryCalls.climbingVolume.push({ input, options });
          return { data: [], isLoading: false, isFetching: false, isError: false, error: null };
        },
      },
      strengths: {
        useQuery: (input: { days: number | null }, options: MockRangeQueryOptions) => {
          mockQueryState.rangeQueryCalls.strengths.push({ input, options });
          return { ...mockStrengthsState };
        },
      },
      locationMap: {
        useQuery: (input: { days: number }, options: MockRangeQueryOptions) => {
          mockQueryState.rangeQueryCalls.locationMap.push({ input, options });
          return { ...mockLocationMapState };
        },
      },
      demonstratedGrade: { useQuery: mockDemonstratedGradeQuery },
    },
    strength: {
      volumeOverTime: {
        useQuery: (input: { days: number }, options: MockRangeQueryOptions) => {
          mockQueryState.rangeQueryCalls.strengthVolume.push({ input, options });
          return { data: [], isLoading: false, isFetching: false, isError: false, error: null };
        },
      },
    },
    mobileDashboard: {
      trainingV2: {
        useQuery: (input: { days: number; endDate?: string }, options: MockRangeQueryOptions) => {
          mockQueryState.rangeQueryCalls.training.push({ input, options });
          return {
            data:
              input.days === mockQueryState.trainingDataDays
                ? mockTrainingState.data
                : options.placeholderData?.(mockTrainingState.data),
            isLoading: mockTrainingState.isLoading,
            isFetching: mockTrainingState.isFetching,
            isError: mockTrainingState.isError,
            error: mockTrainingState.error,
          };
        },
      },
    },
    training: {
      sportVolume: {
        useQuery: (input: { days: number }, options: MockRangeQueryOptions) => {
          mockQueryState.rangeQueryCalls.sportVolume.push({ input, options });
          return { data: undefined, isLoading: false, isFetching: false, error: null };
        },
      },
      hrZones: {
        useQuery: (input: { days: number }, options: MockRangeQueryOptions) => {
          mockQueryState.rangeQueryCalls.hrZones.push({ input, options });
          return { ...mockHrZonesState };
        },
      },
    },
    efficiency: {
      polarizationTrend: {
        useQuery: (input: { days: number }, options: MockRangeQueryOptions) => {
          mockQueryState.rangeQueryCalls.polarization.push({ input, options });
          return { ...mockPolarizationState };
        },
      },
    },
    processing: {
      status: {
        useQuery: () => ({ data: undefined, isLoading: false, error: null }),
      },
      dismiss: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
      },
    },
    useUtils: () => ({
      running: { dynamicsV2: { invalidate: mockRunningInvalidate } },
      hiking: { activityComparison: { invalidate: mockRouteComparisonInvalidate } },
      climbing: {
        attemptIncrease: { invalidate: mockAttemptIncreaseInvalidate },
        volumeIncrease: { invalidate: mockVolumeIncreaseInvalidate },
        volumeOverTime: { invalidate: vi.fn() },
        locationMap: { invalidate: mockLocationMapInvalidate },
        demonstratedGrade: { invalidate: mockDemonstratedGradeInvalidate },
        strengths: { invalidate: vi.fn().mockResolvedValue(undefined) },
      },
      strength: { volumeOverTime: { invalidate: vi.fn() } },
      mobileDashboard: {
        trainingV2: { invalidate: mockTrainingInvalidate },
      },
      training: {
        sportVolume: { invalidate: vi.fn() },
        hrZones: { invalidate: mockHrZonesInvalidate },
      },
      efficiency: {
        polarizationTrend: { invalidate: mockPolarizationInvalidate },
      },
      cyclingAdvanced: {},
      processing: {
        status: { invalidate: mockProcessingStatusInvalidate },
      },
    }),
  },
}));

vi.mock("../../lib/useTimeRangePreference", () => ({
  useTimeRangePreference: () => mockQueryState.timeRangePreference,
}));

vi.mock("../../lib/useRefresh", () => ({
  useRefresh: (input: { invalidate?: (() => Promise<void> | void) | null }) => {
    mockQueryState.refreshInvalidate = input.invalidate;
    return { refreshing: false, onRefresh: vi.fn() };
  },
}));

vi.mock("../../lib/useTodayQueryDate", () => ({
  useTodayQueryDate: () => mockQueryState.todayQueryDate,
}));

vi.mock("../../lib/telemetry", () => ({
  captureException: mockCaptureException,
}));

vi.mock("../../lib/units", () => ({
  useUnitConverter: () => ({
    formatDistance: (km: number) => ({ text: `${km.toFixed(1)} km`, parts: [] }),
    formatElevation: (meters: number) => ({ text: `${meters} m`, parts: [] }),
    convertDistance: (km: number) => km,
    convertPace: (seconds: number) => seconds,
    paceLabel: "/km",
    distanceLabel: "km",
    formatWeight: (kg: number) => ({
      text: `${kg.toFixed(1)} kg`,
      parts: [{ type: "unit", value: "kg" }],
    }),
    convertWeight: (kg: number) => kg,
    weightLabel: "kg",
  }),
}));

export function resetStrainMocks() {
  mockQueryState.focused = true;
  mockVolumeIncreaseQuery.mockReset().mockReturnValue({ data: undefined, error: null });
  mockVolumeIncreaseInvalidate.mockReset().mockResolvedValue(undefined);
  mockDemonstratedGradeQuery.mockReset().mockReturnValue({
    data: undefined,
    isLoading: false,
    isFetching: false,
    error: null,
  });
  mockDemonstratedGradeInvalidate.mockReset().mockResolvedValue(undefined);
  mockAttemptIncreaseQuery.mockReset().mockReturnValue({ data: undefined, error: null });
  mockAttemptIncreaseInvalidate.mockReset().mockResolvedValue(undefined);
  mockQueryState.runningData = { ...runningData, data: [] };
  mockQueryState.runningLoading = false;
  mockQueryState.runningError = null;
  mockRouterPush.mockReset();
  mockCaptureException.mockReset();
  mockRunningInvalidate.mockReset();
  mockRunningInvalidate.mockResolvedValue(undefined);
  mockTrainingInvalidate.mockReset();
  mockLocationMapInvalidate.mockReset();
  mockProcessingStatusInvalidate.mockReset();
  mockRouteComparisonInvalidate.mockReset();
  mockRouteComparisonInvalidate.mockResolvedValue(undefined);
  mockRouteComparisonQuery.mockReset();
  mockRouteComparisonQuery.mockReturnValue({
    data: [],
    isLoading: false,
    isFetching: false,
    error: null,
  });
  mockHrZonesInvalidate.mockReset();
  mockPolarizationInvalidate.mockReset();
  mockTrainingInvalidate.mockResolvedValue(undefined);
  mockLocationMapInvalidate.mockResolvedValue(undefined);
  mockProcessingStatusInvalidate.mockResolvedValue(undefined);
  mockHrZonesInvalidate.mockResolvedValue(undefined);
  mockPolarizationInvalidate.mockResolvedValue(undefined);
  mockQueryState.refreshInvalidate = undefined;
  mockQueryState.trainingDataDays = 90;
  mockQueryState.rangeQueryCalls = emptyRangeQueryCalls();
  mockQueryState.timeRangePreference = {
    days: 90,
    isHydrated: true,
    setDays: vi.fn(),
  };
  resetMockTrainingState();
}
