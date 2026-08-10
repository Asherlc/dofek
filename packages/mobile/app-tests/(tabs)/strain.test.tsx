// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { Alert } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRouterPush = vi.fn();
const mockTrainingInvalidate = vi.fn();
const mockHrZonesInvalidate = vi.fn();
const mockPolarizationInvalidate = vi.fn();
const mockMonotonyInvalidate = vi.fn();
const mockProcessingStatusInvalidate = vi.fn();
let mockRefreshInvalidate: (() => Promise<void> | void) | null | undefined;
let mockTrainingDataDays = 90;
type MockRangeQueryOptions = {
  enabled?: boolean;
  placeholderData?: (previousData: unknown) => unknown;
};
let mockRangeQueryCalls: Record<
  "training" | "hrZones" | "polarization" | "monotony",
  Array<{ input: { days: number; endDate?: string }; options: MockRangeQueryOptions }>
>;
let mockTimeRangePreference = {
  days: 90,
  description: "Recommended default: 90 days balances recent training changes with enough history.",
  isHydrated: true,
  setDays: vi.fn(),
};

type MockTrainingData = Record<string, unknown>;
type MockTrainingState = {
  data: MockTrainingData | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
};

const mockTrainingState: MockTrainingState = {
  data: undefined,
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null,
};

const mockHrZonesState: MockTrainingState = {
  data: undefined,
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null,
};

const mockPolarizationState: MockTrainingState = {
  data: undefined,
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null,
};

const mockMonotonyState: MockTrainingState = {
  data: undefined,
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null,
};

function defaultMockTrainingData(): MockTrainingData {
  return {
    workloadRatio: {
      context: {
        label: "Recent-to-baseline workload ratio",
        description:
          "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
        recentDays: 7,
        baselineDays: 28,
      },
      displayedStrain: 16,
      displayedDate: "2026-03-28",
      timeSeries: [
        {
          date: "2026-03-28",
          acuteLoad: 27.4,
          chronicLoad: 24.9,
          workloadRatio: 1.1,
          strain: 16,
        },
      ],
    },
    strainTarget: undefined,
    activities: [],
    weeklyVolume: [],
    progressiveOverload: [],
    verticalAscent: [],
    climbing: {
      gradeProgression: [],
      volumeByGrade: [],
      sessionSummary: [],
      hangboarding: {
        sessionCount: 0,
        totalDurationSeconds: 0,
        averageDurationSeconds: null,
        totalWorkDurationSeconds: null,
        totalRestDurationSeconds: null,
        workIntervalCount: null,
        averageHeartRate: null,
        peakHeartRate: null,
        latestSession: null,
        daily: [],
      },
    },
  };
}

function resetMockTrainingState() {
  mockTrainingState.data = structuredClone(defaultMockTrainingData());
  mockTrainingState.isLoading = false;
  mockTrainingState.isFetching = false;
  mockTrainingState.isError = false;
  mockTrainingState.error = null;
  for (const state of [mockHrZonesState, mockPolarizationState, mockMonotonyState]) {
    state.data = undefined;
    state.isLoading = false;
    state.isFetching = false;
    state.isError = false;
    state.error = null;
  }
}

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("../../lib/trpc", () => ({
  trpc: {
    mobileDashboard: {
      training: {
        useQuery: (input: { days: number; endDate?: string }, options: MockRangeQueryOptions) => {
          mockRangeQueryCalls.training.push({ input, options });
          return {
            data:
              input.days === mockTrainingDataDays
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
      hrZones: {
        useQuery: (input: { days: number }, options: MockRangeQueryOptions) => {
          mockRangeQueryCalls.hrZones.push({ input, options });
          return { ...mockHrZonesState };
        },
      },
    },
    efficiency: {
      polarizationTrend: {
        useQuery: (input: { days: number }, options: MockRangeQueryOptions) => {
          mockRangeQueryCalls.polarization.push({ input, options });
          return { ...mockPolarizationState };
        },
      },
    },
    cyclingAdvanced: {
      trainingMonotony: {
        useQuery: (input: { days: number }, options: MockRangeQueryOptions) => {
          mockRangeQueryCalls.monotony.push({ input, options });
          return { ...mockMonotonyState };
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
      mobileDashboard: {
        training: { invalidate: mockTrainingInvalidate },
      },
      training: {
        hrZones: { invalidate: mockHrZonesInvalidate },
      },
      efficiency: {
        polarizationTrend: { invalidate: mockPolarizationInvalidate },
      },
      cyclingAdvanced: {
        trainingMonotony: { invalidate: mockMonotonyInvalidate },
      },
      processing: {
        status: { invalidate: mockProcessingStatusInvalidate },
      },
    }),
  },
}));

vi.mock("../../lib/useTimeRangePreference", () => ({
  useTimeRangePreference: () => mockTimeRangePreference,
}));

vi.mock("../../lib/useRefresh", () => ({
  useRefresh: (input: { invalidate?: (() => Promise<void> | void) | null }) => {
    mockRefreshInvalidate = input.invalidate;
    return { refreshing: false, onRefresh: vi.fn() };
  },
}));

vi.mock("../../lib/useTodayQueryDate", () => ({
  useTodayQueryDate: () => "2026-03-28",
}));

vi.mock("../../lib/telemetry", () => ({
  captureException: vi.fn(),
}));

vi.mock("../../lib/units", () => ({
  useUnitConverter: () => ({
    formatDistance: (km: number) => ({ text: `${km.toFixed(1)} km`, parts: [] }),
    formatElevation: (meters: number) => ({ text: `${meters} m`, parts: [] }),
    convertDistance: (km: number) => km,
    distanceLabel: "km",
    formatWeight: (kg: number) => ({
      text: `${kg.toFixed(1)} kg`,
      parts: [{ type: "unit", value: "kg" }],
    }),
    convertWeight: (kg: number) => kg,
    weightLabel: "kg",
  }),
}));

import { captureException } from "../../lib/telemetry";

describe("StrainScreen recent activity navigation", () => {
  beforeEach(() => {
    mockRouterPush.mockReset();
    vi.mocked(captureException).mockReset();
    mockTrainingInvalidate.mockReset();
    mockProcessingStatusInvalidate.mockReset();
    mockHrZonesInvalidate.mockReset();
    mockPolarizationInvalidate.mockReset();
    mockMonotonyInvalidate.mockReset();
    mockTrainingInvalidate.mockResolvedValue(undefined);
    mockProcessingStatusInvalidate.mockResolvedValue(undefined);
    mockHrZonesInvalidate.mockResolvedValue(undefined);
    mockPolarizationInvalidate.mockResolvedValue(undefined);
    mockMonotonyInvalidate.mockResolvedValue(undefined);
    mockRefreshInvalidate = undefined;
    mockTrainingDataDays = 90;
    mockRangeQueryCalls = {
      training: [],
      hrZones: [],
      polarization: [],
      monotony: [],
    };
    mockTimeRangePreference = {
      days: 90,
      description:
        "Recommended default: 90 days balances recent training changes with enough history.",
      isHydrated: true,
      setDays: vi.fn(),
    };
    resetMockTrainingState();
  });

  it("does not consume cached default-range data during preference hydration", async () => {
    mockTimeRangePreference.isHydrated = false;

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    const view = render(<StrainScreen />);

    for (const calls of Object.values(mockRangeQueryCalls)) {
      expect(calls.at(-1)?.options.enabled).toBe(false);
    }
    expect(screen.queryByText("16.0")).toBeNull();

    mockTimeRangePreference.days = 30;
    mockTimeRangePreference.isHydrated = true;
    view.rerender(<StrainScreen />);

    for (const calls of Object.values(mockRangeQueryCalls)) {
      expect(calls.at(-1)?.input.days).toBe(30);
      expect(calls.at(-1)?.options.enabled).toBe(true);
      expect(calls.at(-1)?.options.placeholderData).toBeUndefined();
    }
    expect(screen.queryByText("16.0")).toBeNull();

    mockTrainingDataDays = 30;
    view.rerender(<StrainScreen />);
    mockTimeRangePreference.days = 90;
    view.rerender(<StrainScreen />);

    for (const calls of Object.values(mockRangeQueryCalls)) {
      expect(calls.at(-1)?.options.placeholderData).toBeTypeOf("function");
    }
  });

  it("refreshes training, intensity, polarization, monotony, and processing status together", async () => {
    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(mockRefreshInvalidate).toBeTypeOf("function");
    await mockRefreshInvalidate?.();

    expect(mockTrainingInvalidate).toHaveBeenCalledOnce();
    expect(mockHrZonesInvalidate).toHaveBeenCalledOnce();
    expect(mockPolarizationInvalidate).toHaveBeenCalledOnce();
    expect(mockMonotonyInvalidate).toHaveBeenCalledOnce();
    expect(mockProcessingStatusInvalidate).toHaveBeenCalledOnce();
  });

  it("leads with plain labels while keeping server-owned model details accessible", async () => {
    mockHrZonesState.data = {
      maxHr: 190,
      weeks: [],
      intensityDistribution: {
        model: "karvonen-five-zone",
        activityScope: "endurance",
        totalSeconds: 3600,
        zones: [{ zone: 2, label: "Aerobic", seconds: 3600, percent: 100 }],
        explanation: "Mobile descriptive intensity explanation.",
      },
    };
    mockPolarizationState.data = {
      model: "treff-three-zone",
      activityScope: "cycling",
      threshold: 2,
      maxHr: 190,
      explanation: "Mobile cycling polarization explanation.",
      method: {
        formula: "Mobile Treff formula.",
        zoneBasis: "Mobile Treff zones.",
        calculationChoice: "Mobile calculation choice.",
        interpretation: "Mobile descriptive PI interpretation.",
        source: {
          title: "Treff source",
          url: "https://doi.org/10.3389/fphys.2019.00707",
        },
      },
      weeks: [
        {
          week: "2026-07-20",
          z1Seconds: 4800,
          z2Seconds: 600,
          z3Seconds: 600,
          polarizationIndex: 2,
          totalSeconds: 6000,
          zonePercentages: { z1: 80, z2: 10, z3: 10 },
          status: "not_polarized",
          statusLabel: "Not polarized",
          explanation: "Server says exactly 2.00 is not polarized.",
        },
      ],
    };
    mockMonotonyState.data = [
      {
        week: "2026-07-20",
        monotony: 1.5,
        strain: 300,
        weeklyLoad: 200,
        dailyMeanLoad: 28.57,
        dailyLoadStandardDeviation: 19.05,
        method: {
          formula: "Mobile Foster formula.",
          calendar: "Mobile calendar choice.",
          activityScope: "Mobile activity scope.",
          interpretation: "Mobile descriptive monotony interpretation.",
          source: {
            title: "Foster source",
            url: "https://pubmed.ncbi.nlm.nih.gov/9662690/",
          },
        },
      },
    ];

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    render(<StrainScreen />);

    expect(screen.getByText("Heart-rate zone distribution")).toBeTruthy();
    expect(
      screen.getByText("Shows how recorded heart-rate time is distributed across effort zones."),
    ).toBeTruthy();
    expect(screen.queryByText("Mobile descriptive intensity explanation.")).toBeNull();
    expect(screen.getByText("Not polarized")).toBeTruthy();
    expect(
      screen.getByText("Shows the balance of easy, threshold, and high-intensity cycling."),
    ).toBeTruthy();
    expect(screen.queryByText("Server says exactly 2.00 is not polarized.")).toBeNull();
    expect(screen.getByText("Training variety and total load")).toBeTruthy();
    expect(screen.queryByText("Mobile Foster formula.")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "About How this is calculated for Easy-to-hard training balance",
      }),
    );
    expect(alertSpy).toHaveBeenCalledWith(
      "How this is calculated for Easy-to-hard training balance",
      expect.stringContaining("Server says exactly 2.00 is not polarized."),
      [{ text: "Close" }],
    );
    alertSpy.mockRestore();
  });

  it("renders intensity, polarization, and monotony query failures separately", async () => {
    mockHrZonesState.isError = true;
    mockHrZonesState.error = new Error("Intensity distribution failed");
    mockPolarizationState.isError = true;
    mockPolarizationState.error = new Error("Cycling polarization failed");
    mockMonotonyState.isError = true;
    mockMonotonyState.error = new Error("Training monotony failed");

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getByText("Intensity distribution failed")).toBeTruthy();
    expect(screen.getByText("Cycling polarization failed")).toBeTruthy();
    expect(screen.getByText("Training monotony failed")).toBeTruthy();
    expect(screen.getByText("Could not load easy-to-hard training balance")).toBeTruthy();
    expect(screen.getByText("Could not load training variety and total load")).toBeTruthy();
    expect(captureException).toHaveBeenCalledWith(mockHrZonesState.error);
    expect(captureException).toHaveBeenCalledWith(mockPolarizationState.error);
    expect(captureException).toHaveBeenCalledWith(mockMonotonyState.error);
  });

  it("keeps cached server models visible with background query failures", async () => {
    mockHrZonesState.data = {
      maxHr: 190,
      weeks: [],
      intensityDistribution: {
        model: "karvonen-five-zone",
        activityScope: "endurance",
        totalSeconds: 3600,
        zones: [{ zone: 2, label: "Aerobic", seconds: 3600, percent: 100 }],
        explanation: "Cached mobile intensity distribution.",
      },
    };
    mockHrZonesState.isError = true;
    mockHrZonesState.error = new Error("Intensity refresh failed");
    mockPolarizationState.data = {
      model: "treff-three-zone",
      activityScope: "cycling",
      threshold: 2,
      maxHr: 190,
      explanation: "Cached mobile polarization.",
      method: {
        formula: "Cached Treff formula.",
        zoneBasis: "Cached Treff zones.",
        calculationChoice: "Cached calculation choice.",
        interpretation: "Cached descriptive interpretation.",
        source: {
          title: "Treff source",
          url: "https://doi.org/10.3389/fphys.2019.00707",
        },
      },
      weeks: [],
    };
    mockPolarizationState.isError = true;
    mockPolarizationState.error = new Error("Polarization refresh failed");

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getByText("Intensity refresh failed")).toBeTruthy();
    expect(screen.getByText("Polarization refresh failed")).toBeTruthy();
    expect(
      screen.getByText("Shows how recorded heart-rate time is distributed across effort zones."),
    ).toBeTruthy();
    expect(screen.getByText("No easy-to-hard training balance data in this period")).toBeTruthy();
  });

  it("keeps day selector visible while training data is loading", async () => {
    mockTrainingState.isLoading = true;
    mockTrainingState.data = undefined;

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getByText("30d")).toBeTruthy();
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.queryByText("Loading strain data...")).toBeNull();
  });

  it("does not report response parse errors before training data loads", async () => {
    mockTrainingState.isLoading = true;
    mockTrainingState.data = undefined;

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("keeps cached training data visible while refreshing", async () => {
    mockTrainingState.isLoading = true;
    mockTrainingState.isFetching = true;
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      strainTarget: {
        targetStrain: 14,
        currentStrain: 10,
        progressPercent: 71,
        zone: "Push",
        explanation: "Recovery is strong. Push for a high-strain day to build fitness.",
        dailyLoad: 50,
        acuteLoad: 90,
        chronicLoad: 80,
        workloadRatio: 1.13,
        readinessScore: 78,
      },
      activities: [
        {
          id: 42,
          name: "Morning Ride",
          canonical_type: "cycling",
          started_at: "2026-03-28T07:00:00.000Z",
          ended_at: "2026-03-28T08:00:00.000Z",
          avg_hr: 150,
          max_hr: 178,
          avg_power: 240,
          distance_meters: 24000,
          distance_state: { status: "available" },
          calories: 640,
        },
      ],
    };

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.queryByTestId("query-state-loading")).toBeNull();
    expect(screen.getByText("Daily Strain Target")).toBeTruthy();
    expect(screen.getByText("71% reached")).toBeTruthy();
    expect(screen.getByText("Morning Ride")).toBeTruthy();
  });

  it("navigates to detail screen when a recent activity card is tapped", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      activities: [
        {
          id: 42,
          name: "Morning Ride",
          canonical_type: "cycling",
          started_at: "2026-03-28T07:00:00.000Z",
          ended_at: "2026-03-28T08:00:00.000Z",
          avg_hr: 150,
          max_hr: 178,
          avg_power: 240,
          distance_meters: 24000,
          distance_state: { status: "available" },
          calories: 640,
        },
      ],
    };

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    fireEvent.click(screen.getByText("Morning Ride"));

    expect(mockRouterPush).toHaveBeenCalledWith("/activity/42");
  });

  it("renders strain target card when target data is available", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      strainTarget: {
        targetStrain: 14,
        currentStrain: 10,
        progressPercent: 71,
        zone: "Push",
        explanation: "Recovery is strong (78). Push for a high-strain day to build fitness.",
        dailyLoad: 50,
        acuteLoad: 90,
        chronicLoad: 80,
        workloadRatio: 1.13,
        readinessScore: 78,
      },
    };

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getByText("Daily Strain Target")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
    expect(screen.getByText("Push")).toBeTruthy();
    expect(screen.getByText("71% reached")).toBeTruthy();
  });

  it("shows the neutral server-owned workload comparison", async () => {
    mockTrainingState.data = {
      strainTarget: {
        targetStrain: 12,
        currentStrain: 0,
        progressPercent: 0,
        zone: "Maintain",
        explanation: "Moderate recovery (50). Aim for a steady training day.",
        dailyLoad: 0,
        acuteLoad: 133,
        chronicLoad: 33,
        workloadRatio: 4,
        readinessScore: 50,
      },
      workloadRatio: {
        context: {
          label: "Recent-to-baseline workload ratio",
          description:
            "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
          recentDays: 5,
          baselineDays: 20,
        },
        displayedStrain: 0,
        displayedDate: "2026-03-28",
        timeSeries: [
          {
            date: "2026-03-28",
            dailyLoad: 0,
            acuteLoad: 133,
            chronicLoad: 33,
            workloadRatio: 4,
            strain: 0,
          },
        ],
      },
      activities: [],
      weeklyVolume: [],
      verticalAscent: [],
    };

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getByText("Recent-to-baseline workload ratio")).toBeTruthy();
    expect(screen.getByText("Recent 5-day load")).toBeTruthy();
    expect(screen.getByText("20-day baseline load")).toBeTruthy();
    expect(
      screen.getByText(
        "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("4.00")).toBeTruthy();
  });

  it("constrains training load metrics to equal columns with centered wrapping labels", async () => {
    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    for (const label of [
      "Recent 7-day load",
      "28-day baseline load",
      "Recent-to-baseline workload ratio",
    ]) {
      const labelElement = screen.getByText(label);

      expect(labelElement.parentElement?.style.flex).toBe("1 1 0%");
      expect(labelElement.style.textAlign).toBe("center");
    }
  });

  it("does not use a prior displayed strain as today's strain fallback", async () => {
    mockTrainingState.data = {
      strainTarget: undefined,
      workloadRatio: {
        context: {
          label: "Recent-to-baseline workload ratio",
          description:
            "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
          recentDays: 7,
          baselineDays: 28,
        },
        displayedStrain: 13,
        displayedDate: "2026-03-27",
        timeSeries: [
          {
            date: "2026-03-28",
            dailyLoad: 0,
            acuteLoad: 133,
            chronicLoad: 33,
            workloadRatio: 4,
            strain: 0,
          },
        ],
      },
      activities: [],
      weeklyVolume: [],
      verticalAscent: [],
    };

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.queryByText("13.0")).toBeNull();
    expect(screen.getAllByText("0.0").length).toBeGreaterThan(0);
  });

  it("does not render strain target card when no target data", async () => {
    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.queryByText("Daily Strain Target")).toBeNull();
  });

  it("navigates to activities list when tapping View all", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      activities: [
        {
          id: 42,
          name: "Morning Ride",
          canonical_type: "cycling",
          started_at: "2026-03-28T07:00:00.000Z",
          ended_at: "2026-03-28T08:00:00.000Z",
          avg_hr: 150,
          max_hr: 178,
          avg_power: 240,
          distance_meters: 24000,
          distance_state: { status: "available" },
          calories: 640,
        },
      ],
    };

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    fireEvent.click(screen.getByText("View all"));

    expect(mockRouterPush).toHaveBeenCalledWith("/activities");
  });

  it("shows empty state and View all link when no activities exist", async () => {
    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getByText("Recent Activities")).toBeTruthy();
    expect(screen.getByText("No recent activities")).toBeTruthy();
    expect(screen.getByText("View all")).toBeTruthy();
  });

  it("navigates to activities list from View all when no activities exist", async () => {
    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    fireEvent.click(screen.getByText("View all"));

    expect(mockRouterPush).toHaveBeenCalledWith("/activities");
  });

  it("renders server-provided climbing grade progression, volume, and sessions", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      climbing: {
        gradeProgression: [
          {
            date: "2026-07-09",
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V4",
            gradeSortValue: 4,
          },
        ],
        volumeByGrade: [
          {
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V4",
            gradeSortValue: 4,
            attempts: 8,
            sends: 5,
          },
        ],
        sessionSummary: [
          {
            activityId: "activity-1",
            date: "2026-07-09",
            name: "Kaya climbing at Touchstone Pacific Pipe",
            locationName: "Touchstone Pacific Pipe",
            attempts: 8,
            sends: 5,
            hardestBoulderGrade: "V4",
            hardestBoulderGradeSortValue: 4,
            hardestRouteGrade: null,
            hardestRouteGradeSortValue: null,
          },
        ],
      },
    };

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getByText("Climbing")).toBeTruthy();
    expect(screen.getByText("Best Boulder Grade")).toBeTruthy();
    expect(screen.getAllByText("V4").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("8 attempts")).toBeTruthy();
    expect(screen.getByText("5 sends")).toBeTruthy();
    expect(screen.getByText("Kaya climbing at Touchstone Pacific Pipe")).toBeTruthy();
  });

  it("reports malformed climbing rows while rendering valid partial climbing data", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      climbing: {
        gradeProgression: [
          {
            date: "2026-07-09",
            climbType: "boulder",
            grade: "V4",
            gradeSortValue: 4,
          },
        ],
        volumeByGrade: [{ climbType: "boulder", grade: "V4", gradeSortValue: "bad" }],
        sessionSummary: [],
      },
    };

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getByText("Best Boulder Grade")).toBeTruthy();
    expect(screen.getByText("V4")).toBeTruthy();
    expect(screen.getByText(/strain:climbing.volumeByGrade/)).toBeTruthy();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      context: "strain:climbing.volumeByGrade",
      zodError: expect.any(Object),
    });
  });

  it("renders server-computed Hangboarding summary metrics and duration trend", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      climbing: {
        ...defaultMockTrainingData().climbing,
        hangboarding: {
          sessionCount: 2,
          totalDurationSeconds: 1500,
          averageDurationSeconds: 750,
          totalWorkDurationSeconds: 17,
          totalRestDurationSeconds: 103,
          workIntervalCount: 2,
          averageHeartRate: 125,
          peakHeartRate: 150,
          latestSession: {
            activityId: "activity-2",
            startedAt: "2026-08-08T14:00:00.000Z",
            planName: "7/3 Repeaters",
            boardName: "Tension Board",
            durationSeconds: 900,
          },
          daily: [
            {
              date: "2026-08-07",
              sessionCount: 1,
              durationSeconds: 600,
              workDurationSeconds: 7,
              restDurationSeconds: 53,
            },
            {
              date: "2026-08-08",
              sessionCount: 1,
              durationSeconds: 900,
              workDurationSeconds: 10,
              restDurationSeconds: 50,
            },
          ],
        },
      },
    };

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    for (const label of [
      "Sessions",
      "Total Time",
      "Avg Session",
      "Work Time",
      "Rest Time",
      "Work Intervals",
      "Avg Heart Rate",
      "Peak Heart Rate",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByText("2").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("25m")).toBeTruthy();
    expect(screen.getByText("13m")).toBeTruthy();
    expect(screen.getByText("17s")).toBeTruthy();
    expect(screen.getByText("2m")).toBeTruthy();
    expect(screen.getByText("125 bpm")).toBeTruthy();
    expect(screen.getByText("150 bpm")).toBeTruthy();
    expect(screen.getByText("7/3 Repeaters")).toBeTruthy();
    expect(screen.getByText("Tension Board")).toBeTruthy();
    expect(screen.getByText("15m")).toBeTruthy();
    expect(screen.getByText(/2026/)).toBeTruthy();
  });

  it("shows the Hangboarding empty state", async () => {
    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getByText("No Hangboarding sessions yet.")).toBeTruthy();
  });

  it("reports malformed Hangboarding daily rows while rendering valid summary metrics", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      climbing: {
        ...defaultMockTrainingData().climbing,
        hangboarding: {
          ...defaultMockTrainingData().climbing.hangboarding,
          sessionCount: 1,
          totalDurationSeconds: 600,
          averageDurationSeconds: 600,
          daily: [{ date: "bad", sessionCount: "bad", durationSeconds: 600 }],
        },
      },
    };

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText(/strain:climbing.hangboarding.daily/)).toBeTruthy();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      context: "strain:climbing.hangboarding.daily",
      zodError: expect.any(Object),
    });
  });

  it("preserves cached Hangboarding data during a failed training refresh", async () => {
    mockTrainingState.data = defaultMockTrainingData();
    mockTrainingState.isError = true;
    mockTrainingState.error = new Error("Training refresh failed");

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getByText("No Hangboarding sessions yet.")).toBeTruthy();
    expect(screen.queryByText("Training refresh failed")).toBeNull();
  });

  it("shows the best climbing grade instead of the most recent lower grade", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      climbing: {
        gradeProgression: [
          {
            date: "2026-07-08",
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V5",
            gradeSortValue: 5,
          },
          {
            date: "2026-07-09",
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V3",
            gradeSortValue: 3,
          },
        ],
        volumeByGrade: [],
        sessionSummary: [],
      },
    };

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getByText("Best Boulder Grade")).toBeTruthy();
    expect(screen.getByText("V5")).toBeTruthy();
  });

  it("renders climbing empty states from empty server arrays", async () => {
    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getByText("No climbing grade progression")).toBeTruthy();
    expect(screen.getByText("No climbing volume by grade")).toBeTruthy();
    expect(screen.getByText("No climbing sessions")).toBeTruthy();
  });

  it("renders server-authored exercise trend evidence", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      progressiveOverload: [
        {
          exerciseName: "Back Squat",
          observations: [
            { week: "2026-03-09", totalVolumeKg: 1_000 },
            { week: "2026-03-23", totalVolumeKg: 1_200 },
          ],
          period: {
            startWeek: "2026-03-09",
            endWeek: "2026-03-23",
            observationCount: 2,
            elapsedWeekCount: 3,
          },
          slopeKgPerWeek: 100,
          trend: "increasing",
          uncertainty: {
            availability: "unavailable",
            level: 0.95,
            method: "residual_circular_moving_block_bootstrap",
            methodLabel: "95% moving-block interval",
            reason: "insufficient_observations",
            statement: "Uncertainty needs at least 4 recorded weeks; this estimate has 2.",
          },
          interpretation:
            "Recorded weekly volume increased over this period. An increase is not inherently good or bad.",
          deloadContext:
            "Recorded volume cannot distinguish a planned deload from missed training or incomplete data.",
        },
      ],
    };

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getByText("Back Squat")).toBeTruthy();
    expect(screen.getByText("Increasing 100.0 kg/week")).toBeTruthy();
    expect(
      screen.getByText("Uncertainty needs at least 4 recorded weeks; this estimate has 2."),
    ).toBeTruthy();
  });

  it("shows one server error notice for a failed composite training query", async () => {
    mockTrainingState.data = undefined;
    mockTrainingState.isError = true;
    mockTrainingState.error = new Error("Training data failed to load");

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getAllByText("Training data failed to load")).toHaveLength(1);
    expect(screen.getAllByTestId("query-state-error")).toHaveLength(1);
    expect(screen.queryByText("Training Load")).toBeNull();
    expect(screen.queryByText("Climbing")).toBeNull();
    expect(screen.queryByText("Weekly Volume")).toBeNull();
    expect(screen.queryByText("Recent Activities")).toBeNull();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
  });

  it("keeps successful companion analytics visible beside a training query failure", async () => {
    mockTrainingState.data = undefined;
    mockTrainingState.isError = true;
    mockTrainingState.error = new Error("Training data failed to load");
    mockHrZonesState.data = {
      maxHr: 190,
      weeks: [],
      intensityDistribution: {
        model: "karvonen-five-zone",
        activityScope: "endurance",
        totalSeconds: 3600,
        zones: [{ zone: 2, label: "Aerobic", seconds: 3600, percent: 100 }],
        explanation: "Independent intensity data remains available.",
      },
    };

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getAllByText("Training data failed to load")).toHaveLength(1);
    expect(
      screen
        .getByRole("button", {
          name: "About How this is calculated for Heart-rate zone distribution",
        })
        .getAttribute("aria-description"),
    ).toContain("Independent intensity data remains available.");
  });

  it("keeps equal messages separate when training and companion queries both fail", async () => {
    mockTrainingState.data = undefined;
    mockTrainingState.isError = true;
    mockTrainingState.error = new Error("Training analytics unavailable");
    mockHrZonesState.isError = true;
    mockHrZonesState.error = new Error("Training analytics unavailable");

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.getAllByText("Training analytics unavailable")).toHaveLength(2);
    expect(screen.getAllByTestId("query-state-error")).toHaveLength(2);
  });

  it("keeps cached climbing data visible during background refetch failures", async () => {
    mockTrainingState.data = {
      ...defaultMockTrainingData(),
      climbing: {
        gradeProgression: [
          {
            date: "2026-07-09",
            climbType: "boulder",
            grade: "V4",
            gradeSortValue: 4,
          },
        ],
        volumeByGrade: [],
        sessionSummary: [],
      },
    };
    mockTrainingState.isError = true;
    mockTrainingState.error = new Error("Climbing refresh failed");

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    render(<StrainScreen />);

    expect(screen.queryByText("Climbing refresh failed")).toBeNull();
    expect(screen.getByText("Best Boulder Grade")).toBeTruthy();
    expect(screen.getByText("V4")).toBeTruthy();
  });

  it("reports the same cached training query error only once across remounts", async () => {
    const cachedError = new Error("Cached climbing data failed to load");
    mockTrainingState.data = undefined;
    mockTrainingState.isError = true;
    mockTrainingState.error = cachedError;

    const { default: StrainScreen } = await import("../../app/(tabs)/strain");
    const firstRender = render(<StrainScreen />);
    firstRender.unmount();
    render(<StrainScreen />);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(cachedError);
  });
});
