import type { PlannedIntervalInput } from "@dofek/format/planned-interval";
import type { UnitSystem } from "@dofek/format/units";
import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import { render } from "@testing-library/react";
import type { AppRouterOutputs } from "dofek-server/router";
import type { ReactNode } from "react";
import { vi } from "vitest";
import type {
  ActivityHeartRateContext,
  ActivityMetricSources,
} from "../../../server/src/contracts/activity-metric-sources.ts";
import type { ClimbingLogEntryDetail } from "../../../server/src/contracts/climbing-log-contracts.ts";
import type { CyclingThresholdEvidence } from "../../../server/src/contracts/cycling-threshold.ts";
import type { ActivityDetail } from "../../../server/src/models/activity.ts";
import type { useAuth } from "../lib/auth-context.tsx";
import * as maplibreTestHelpers from "../lib/maplibre-test-helpers.ts";
import { UnitContext } from "../lib/unitContext.ts";
import { detailPageActivity, detailPageStreamPoints } from "./ActivityDetailPage.fixtures.ts";

export const maps = maplibreTestHelpers.maps;
export const markers = maplibreTestHelpers.markers;

export const capturedOptions: Array<Record<string, unknown>> = [];
export const capturedEvents: Array<
  Record<string, (...params: Array<Record<string, unknown>>) => void>
> = [];

vi.mock("maplibre-gl", async () => {
  const helper = await import("../lib/maplibre-test-helpers.ts");
  return {
    ...helper.maplibreMock,
    Map: class extends helper.TestMap {
      constructor(options: Record<string, unknown>) {
        super(options);
        queueMicrotask(() => this.fire("load"));
      }
    },
  };
});

vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url", () => ({
  default: "/maplibre-worker.js",
}));

vi.mock("echarts-for-react", () => ({
  default: (props: {
    option: Record<string, unknown>;
    onEvents?: Record<string, (...params: Array<Record<string, unknown>>) => void>;
  }) => {
    capturedOptions.push(props.option);
    if (props.onEvents) capturedEvents.push(props.onEvents);
    return <div data-testid="echarts" />;
  },
}));

const routeMocks = vi.hoisted(() => ({ activityRouteParams: { id: "test-123" } }));
export const activityRouteParams = routeMocks.activityRouteParams;
vi.mock("@tanstack/react-router", () => ({
  useParams: () => routeMocks.activityRouteParams,
  useNavigate: () => vi.fn(),
  Link: ({
    children,
    ...props
  }: {
    children: ReactNode;
    to: string;
    search?: Record<string, unknown>;
  }) => (
    <a href={props.to} data-search={JSON.stringify(props.search)}>
      {children}
    </a>
  ),
}));

const authenticatedRoute = vi.hoisted(
  () =>
    ({
      user: {
        id: "activity-detail-test-user",
        name: "Activity Detail Test User",
        email: "activity-detail@example.test",
      },
      accountSessionOwnerNonce: "activity-detail-test-session",
    }) satisfies Pick<ReturnType<typeof useAuth>, "user" | "accountSessionOwnerNonce">,
);

vi.mock("../lib/auth-context.tsx", () => ({ useAuth: () => authenticatedRoute }));

export const mockActivity = structuredClone(detailPageActivity);
export const mockStreamPoints = detailPageStreamPoints.map((point) => ({ ...point }));
const initialMockStreamPoints = mockStreamPoints.map((point) => ({ ...point }));

export function setCyclingPowerActivity(power = 210) {
  Object.assign(mockActivity, { activityType: "cycling", avgPower: 220, maxPower: 360 });
  mockStreamPoints.splice(
    0,
    mockStreamPoints.length,
    ...mockStreamPoints.map((point) => ({ ...point, power })),
  );
}

interface MockQueryResult<T> {
  data: T | undefined;
  error: Error | null;
  isError: boolean;
  isLoading: boolean;
  isFetching?: boolean;
  isPlaceholderData?: boolean;
}

export function queryResult<T>(
  data: T,
  overrides?: Partial<MockQueryResult<T>>,
): Omit<MockQueryResult<T>, "data"> & { data: T };
export function queryResult<T>(
  data: undefined,
  overrides?: Partial<MockQueryResult<T>>,
): MockQueryResult<T>;
export function queryResult<T>(
  data: T | undefined,
  overrides: Partial<MockQueryResult<T>> = {},
): MockQueryResult<T> {
  return {
    data,
    error: null,
    isError: false,
    isLoading: false,
    isFetching: false,
    isPlaceholderData: false,
    ...overrides,
  };
}

export const mockActivityByIdUseQuery = vi.fn<
  () => MockQueryResult<ActivityDetail> & { error: (Error & { data?: { code?: string } }) | null }
>(() => ({
  data: mockActivity,
  error: null,
  isError: false,
  isLoading: false,
}));
export const mockStrengthExercisesUseQuery = vi.fn(
  (_input?: unknown, _options?: { enabled?: boolean }): MockQueryResult<unknown[]> => ({
    data: [],
    error: null,
    isError: false,
    isLoading: false,
  }),
);
export const mockHangboardDetailsUseQuery = vi.fn(
  (_input?: unknown, _options?: { enabled?: boolean }): MockQueryResult<unknown> => ({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
  }),
);
export const mockClimbingEntriesUseQuery = vi.fn(
  (
    _input?: unknown,
    _options?: { enabled?: boolean },
  ): {
    data: ClimbingLogEntryDetail[] | undefined;
    error: Error | null;
    isError: boolean;
    isLoading: boolean;
  } => ({
    data: [],
    error: null,
    isError: false,
    isLoading: false,
  }),
);
export const mockEntrySuggestionsUseQuery = vi.fn(
  (
    _input?: unknown,
    _options?: { enabled?: boolean },
  ): {
    data: ClimbingLogEntryDetail[] | undefined;
    error: unknown | null;
    isLoading: boolean;
  } => ({
    data: [],
    error: null,
    isLoading: false,
  }),
);
export const mockAttachEntryMutate = vi.fn();
export const mockAttachShouldFail = vi.fn(() => false);
export const mockActivityImagesInvalidate = vi.fn().mockResolvedValue(undefined);
export const mockClimbingEntriesInvalidate = vi.fn().mockResolvedValue(undefined);
export const mockEntrySuggestionsInvalidate = vi.fn().mockResolvedValue(undefined);
export const mockClimbingSessionSummaryInvalidate = vi.fn().mockResolvedValue(undefined);
export const mockClimbingGradeProgressionInvalidate = vi.fn().mockResolvedValue(undefined);
export const mockClimbingStrengthsInvalidate = vi.fn().mockResolvedValue(undefined);
export const mockClimbingVolumeByGradeInvalidate = vi.fn().mockResolvedValue(undefined);

interface MockHrZone {
  zone: number;
  label: string;
  minPct: number;
  maxPct: number;
  seconds: number;
  percent: number;
}

interface MockPowerZone {
  zone: number;
  label: string;
  minPct: number;
  maxPct: number | null;
  seconds: number;
  percent: number;
}

interface MockPowerZonesResult {
  activityDate: string;
  ftp: number | null;
  thresholdEvidence: CyclingThresholdEvidence;
  zones: MockPowerZone[];
}

interface MockHrZonesResult {
  data: MockHrZone[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

const emptyHrZones: MockHrZone[] = [];

function defaultMockHrZonesResult(): MockHrZonesResult {
  return {
    data: emptyHrZones,
    isLoading: false,
    isError: false,
    error: null,
  };
}

export const mockHrZonesUseQuery = vi.fn(
  (_input?: unknown, _options?: unknown): MockHrZonesResult => defaultMockHrZonesResult(),
);
export const mockStreamUseQuery = vi.fn(
  (_input?: unknown, _options?: unknown): MockQueryResult<typeof mockStreamPoints> => ({
    data: mockStreamPoints,
    error: null,
    isError: false,
    isLoading: false,
    isPlaceholderData: false,
  }),
);
export const mockHeartRateContextQuery = vi.fn(
  (_input?: unknown, _options?: unknown): MockQueryResult<ActivityHeartRateContext> => ({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
  }),
);
type MockRouteData =
  | { status: "processing" | "unavailable" }
  | { status: "ready"; points: Array<{ lat: number | null; lng: number | null }> };
export const mockRouteUseQuery = vi.fn(
  (
    _input?: unknown,
    _options?: unknown,
  ): {
    data: MockRouteData;
    error: Error | null;
    isLoading: boolean;
  } => ({
    data: {
      status: "ready",
      points: mockStreamPoints.map((point) => ({ lat: point.lat, lng: point.lng })),
    },
    error: null,
    isLoading: false,
  }),
);
export const mockPowerZonesUseQuery = vi.fn(
  (_input?: unknown, _options?: { enabled?: boolean }): MockQueryResult<MockPowerZonesResult> => ({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
  }),
);

export function setCyclingPowerZoneResult(
  data: MockPowerZonesResult | undefined,
  overrides: Partial<MockQueryResult<MockPowerZonesResult>> = {},
) {
  setCyclingPowerActivity();
  mockPowerZonesUseQuery.mockReturnValue({
    data,
    error: null,
    isError: false,
    isLoading: false,
    ...overrides,
  });
}

export const mockPowerWorkUseQuery = vi.fn(
  (
    _input?: unknown,
    _options?: unknown,
  ): MockQueryResult<{
    workKilojoules: number | null;
    coverage: { coveredSeconds: number; coveragePct: number };
  }> => ({ data: undefined, error: null, isError: false, isLoading: false }),
);
export const mockPlannedIntervalsUseQuery = vi.fn(
  (_input?: unknown, _options?: unknown): MockQueryResult<PlannedIntervalInput[]> => ({
    data: [],
    error: null,
    isError: false,
    isLoading: false,
  }),
);

type CyclingProgression = AppRouterOutputs["trainingProgression"]["cycling"];
export const mockTrainingProgressionCyclingUseQuery = vi.fn(
  (
    _input?: { activityId: string },
    _options?: { enabled?: boolean },
  ): MockQueryResult<CyclingProgression> => ({
    data: null,
    error: null,
    isError: false,
    isLoading: false,
  }),
);
export const mockMetricSourcesUseQuery = vi.fn(
  (): MockQueryResult<ActivityMetricSources> => ({
    data: [],
    error: null,
    isError: false,
    isLoading: false,
  }),
);
export const mockHardwareUseQuery = vi.fn(
  (): {
    data: ActivityHardware;
    isLoading: boolean;
    error: Error | null;
    refetch: () => void;
  } => ({ data: { items: [], power: [] }, isLoading: false, error: null, refetch: vi.fn() }),
);
export const mockImagesUseQuery = vi.fn(() => ({
  data: { images: [], coverage: [], acquisition: [] },
  error: null,
  isLoading: false,
  isFetching: false,
  refetch: vi.fn(),
}));
export const mockRestoreProviderAbsentMutate = vi.fn();
export const mockRestoreResult = vi.fn<() => { analyticsJobId: string } | undefined>(
  () => undefined,
);
export const mockRestoreStatus = vi.fn<
  () => { data: { status: "pending" | "completed"; error: null } | undefined; error: null }
>(() => ({ data: undefined, error: null }));
export const mockActivityByIdInvalidate = vi.fn().mockResolvedValue(undefined);
export const mockActivityInvalidate = vi.fn().mockResolvedValue(undefined);
export const mockActivityStreamInvalidate = vi.fn().mockResolvedValue(undefined);
export const mockActivityHrZonesInvalidate = vi.fn().mockResolvedValue(undefined);
export const mockActivityPowerZonesInvalidate = vi.fn().mockResolvedValue(undefined);
export const mockActivityPowerWorkInvalidate = vi.fn().mockResolvedValue(undefined);
export const mockActivityStrengthExercisesInvalidate = vi.fn().mockResolvedValue(undefined);
export const mockActivityListInvalidate = vi.fn().mockResolvedValue(undefined);
export const mockCalendarWeekListInvalidate = vi.fn().mockResolvedValue(undefined);
export const mockCalendarActivityOverviewInvalidate = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    intervals: { plannedByActivity: { useQuery: mockPlannedIntervalsUseQuery } },
    trainingProgression: { cycling: { useQuery: mockTrainingProgressionCyclingUseQuery } },
    activity: {
      images: { useQuery: mockImagesUseQuery },
      byId: { useQuery: mockActivityByIdUseQuery },
      stream: { useQuery: mockStreamUseQuery },
      heartRateContext: { useQuery: mockHeartRateContextQuery },
      metricSources: { useQuery: mockMetricSourcesUseQuery },
      hardware: { useQuery: mockHardwareUseQuery },
      route: { useQuery: mockRouteUseQuery },
      hrZones: { useQuery: mockHrZonesUseQuery },
      powerZones: { useQuery: mockPowerZonesUseQuery },
      powerWork: { useQuery: mockPowerWorkUseQuery },
      strengthExercises: { useQuery: mockStrengthExercisesUseQuery },
      hangboardDetails: { useQuery: mockHangboardDetailsUseQuery },
      recompute: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      delete: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      recomputeStatus: { useQuery: () => ({ data: undefined, error: null }) },
      restoreStatus: { useQuery: mockRestoreStatus },
      restoreProviderAbsent: {
        useMutation: (options?: {
          onSuccess?: () => Promise<void>;
          onError?: (error: Error) => void;
        }) => ({
          mutate: (input: { ids: string[] }) => {
            mockRestoreProviderAbsentMutate(input);
            void options?.onSuccess?.();
          },
          data: mockRestoreResult(),
          isPending: false,
          error: null,
          reset: vi.fn(),
        }),
      },
    },
    climbing: {
      activityLogEntries: { useQuery: mockClimbingEntriesUseQuery },
      unattachedClimbingLogEntries: { useQuery: mockEntrySuggestionsUseQuery },
      attachClimbingLogEntry: {
        useMutation: (options?: {
          onSuccess?: (
            result: { attached: true },
            input: { activityId: string; climbingLogEntryId: string },
          ) => Promise<void> | void;
          onError?: (
            error: Error,
            input: { activityId: string; climbingLogEntryId: string },
          ) => void;
        }) => ({
          mutate: (
            input: { activityId: string; climbingLogEntryId: string },
            callbacks?: { onSuccess?: () => void; onError?: (error: Error) => void },
          ) => {
            mockAttachEntryMutate(input);
            if (mockAttachShouldFail()) {
              const error = new Error("This climbing entry is no longer available.");
              options?.onError?.(error, input);
              callbacks?.onError?.(error);
              return;
            }
            void options?.onSuccess?.({ attached: true }, input);
            callbacks?.onSuccess?.();
          },
          isPending: false,
        }),
      },
    },
    useUtils: () => ({
      activity: {
        invalidate: mockActivityInvalidate,
        images: { invalidate: mockActivityImagesInvalidate },
        byId: { invalidate: mockActivityByIdInvalidate },
        stream: { invalidate: mockActivityStreamInvalidate },
        heartRateContext: { invalidate: vi.fn().mockResolvedValue(undefined) },
        hrZones: { invalidate: mockActivityHrZonesInvalidate },
        powerZones: { invalidate: mockActivityPowerZonesInvalidate },
        powerWork: { invalidate: mockActivityPowerWorkInvalidate },
        strengthExercises: { invalidate: mockActivityStrengthExercisesInvalidate },
        list: { invalidate: mockActivityListInvalidate },
      },
      calendar: {
        weekListV2: { invalidate: mockCalendarWeekListInvalidate },
        activityOverview: { invalidate: mockCalendarActivityOverviewInvalidate },
        calendarData: { invalidate: vi.fn().mockResolvedValue(undefined) },
      },
      climbing: {
        activityLogEntries: { invalidate: mockClimbingEntriesInvalidate },
        unattachedClimbingLogEntries: { invalidate: mockEntrySuggestionsInvalidate },
        sessionSummary: { invalidate: mockClimbingSessionSummaryInvalidate },
        gradeProgressionV2: { invalidate: mockClimbingGradeProgressionInvalidate },
        strengths: { invalidate: mockClimbingStrengthsInvalidate },
        volumeByGrade: { invalidate: mockClimbingVolumeByGradeInvalidate },
        attemptIncrease: { invalidate: vi.fn().mockResolvedValue(undefined) },
      },
    }),
  },
}));

vi.mock("react-body-highlighter", () => ({
  default: ({ type }: { type: string }) => <div data-testid={`muscle-map-${type}`} />,
  MuscleType: {
    BACK_DELTOIDS: "back_deltoids",
    CHEST: "chest",
    FRONT_DELTOIDS: "front_deltoids",
  },
}));

export function resetActivityDetailPageMocks() {
  activityRouteParams.id = "test-123";
  Object.assign(mockActivity, structuredClone(detailPageActivity));
  mockRestoreProviderAbsentMutate.mockClear();
  mockRestoreResult.mockReturnValue(undefined);
  mockRestoreStatus.mockReturnValue({ data: undefined, error: null });
  mockHardwareUseQuery.mockReset();
  mockHardwareUseQuery.mockReturnValue({
    data: { items: [], power: [] },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  mockMetricSourcesUseQuery.mockReset();
  mockMetricSourcesUseQuery.mockReturnValue({
    data: [],
    error: null,
    isError: false,
    isLoading: false,
  });
  mockActivityByIdUseQuery.mockReset();
  mockActivityByIdUseQuery.mockReturnValue({
    data: mockActivity,
    error: null,
    isError: false,
    isLoading: false,
  });
  mockStreamUseQuery.mockClear();
  mockHeartRateContextQuery.mockReset();
  mockHeartRateContextQuery.mockReturnValue({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
  });
  mockStreamUseQuery.mockImplementation((_input?: unknown, _options?: unknown) => ({
    data: mockStreamPoints,
    error: null,
    isError: false,
    isLoading: false,
    isPlaceholderData: false,
  }));
  mockRouteUseQuery.mockReset();
  mockRouteUseQuery.mockImplementation((_input?: unknown, _options?: unknown) => ({
    data: {
      status: "ready",
      points: mockStreamPoints.map((point) => ({ lat: point.lat, lng: point.lng })),
    },
    error: null,
    isLoading: false,
  }));
  mockHrZonesUseQuery.mockReset();
  mockHrZonesUseQuery.mockImplementation(
    (_input?: unknown, _options?: unknown): MockHrZonesResult => defaultMockHrZonesResult(),
  );
  mockClimbingEntriesUseQuery.mockReset();
  mockClimbingEntriesUseQuery.mockReturnValue({
    data: [],
    error: null,
    isError: false,
    isLoading: false,
  });
  mockEntrySuggestionsUseQuery.mockReset();
  mockEntrySuggestionsUseQuery.mockReturnValue({ data: [], error: null, isLoading: false });
  mockAttachEntryMutate.mockClear();
  mockAttachShouldFail.mockReset();
  mockAttachShouldFail.mockReturnValue(false);
  mockActivityImagesInvalidate.mockClear();
  mockClimbingEntriesInvalidate.mockClear();
  mockEntrySuggestionsInvalidate.mockClear();
  mockClimbingSessionSummaryInvalidate.mockClear();
  mockClimbingGradeProgressionInvalidate.mockClear();
  mockClimbingStrengthsInvalidate.mockClear();
  mockClimbingVolumeByGradeInvalidate.mockClear();
  mockStrengthExercisesUseQuery.mockReset();
  mockStrengthExercisesUseQuery.mockReturnValue({
    data: [],
    error: null,
    isError: false,
    isLoading: false,
  });
  mockHangboardDetailsUseQuery.mockReset();
  mockHangboardDetailsUseQuery.mockReturnValue({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
  });
  mockPowerZonesUseQuery.mockReset();
  mockPlannedIntervalsUseQuery.mockReset();
  mockPlannedIntervalsUseQuery.mockReturnValue({
    data: [],
    error: null,
    isError: false,
    isLoading: false,
  });
  mockTrainingProgressionCyclingUseQuery.mockReset();
  mockTrainingProgressionCyclingUseQuery.mockReturnValue({
    data: null,
    error: null,
    isError: false,
    isLoading: false,
  });
  mockPowerWorkUseQuery.mockReset();
  mockPowerWorkUseQuery.mockReturnValue({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
  });
  mockActivityPowerWorkInvalidate.mockClear();
  mockPowerZonesUseQuery.mockReturnValue({
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
  });
  mockStreamPoints.splice(
    0,
    mockStreamPoints.length,
    ...initialMockStreamPoints.map((point) => ({ ...point })),
  );
}

export function renderWithUnits(ui: ReactNode, unitSystem: UnitSystem = "metric") {
  capturedOptions.length = 0;
  capturedEvents.length = 0;
  maplibreTestHelpers.resetMaps();
  mockStrengthExercisesUseQuery.mockClear();
  mockHangboardDetailsUseQuery.mockClear();
  mockClimbingEntriesUseQuery.mockClear();
  mockHrZonesUseQuery.mockClear();
  mockPowerZonesUseQuery.mockClear();
  mockActivityByIdInvalidate.mockClear();
  mockActivityInvalidate.mockClear();
  mockActivityStreamInvalidate.mockClear();
  mockActivityHrZonesInvalidate.mockClear();
  mockActivityPowerZonesInvalidate.mockClear();
  mockActivityStrengthExercisesInvalidate.mockClear();
  mockActivityListInvalidate.mockClear();
  mockCalendarWeekListInvalidate.mockClear();
  mockCalendarActivityOverviewInvalidate.mockClear();
  return render(
    <UnitContext.Provider value={{ unitSystem, setUnitSystem: () => {} }}>
      {ui}
    </UnitContext.Provider>,
  );
}
