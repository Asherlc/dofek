// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRouterPush = vi.fn();
const mockTrainingInvalidate = vi.fn();
const mockProcessingStatusInvalidate = vi.fn();
let mockRefreshInvalidate: (() => Promise<void> | void) | null | undefined;

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

function defaultMockTrainingData(): MockTrainingData {
  return {
    workloadRatio: {
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
    verticalAscent: [],
    climbing: {
      gradeProgression: [],
      volumeByGrade: [],
      sessionSummary: [],
    },
  };
}

function resetMockTrainingState() {
  mockTrainingState.data = structuredClone(defaultMockTrainingData());
  mockTrainingState.isLoading = false;
  mockTrainingState.isFetching = false;
  mockTrainingState.isError = false;
  mockTrainingState.error = null;
}

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("../../lib/trpc", () => ({
  trpc: {
    mobileDashboard: {
      training: {
        useQuery: () => ({
          data: mockTrainingState.data,
          isLoading: mockTrainingState.isLoading,
          isFetching: mockTrainingState.isFetching,
          isError: mockTrainingState.isError,
          error: mockTrainingState.error,
        }),
      },
    },
    processing: {
      status: {
        useQuery: () => ({ data: undefined, isLoading: false, error: null }),
      },
    },
    useUtils: () => ({
      mobileDashboard: {
        training: { invalidate: mockTrainingInvalidate },
      },
      processing: {
        status: { invalidate: mockProcessingStatusInvalidate },
      },
    }),
  },
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
  }),
}));

import { captureException } from "../../lib/telemetry";

describe("StrainScreen recent activity navigation", () => {
  beforeEach(() => {
    mockRouterPush.mockReset();
    vi.mocked(captureException).mockReset();
    mockTrainingInvalidate.mockReset();
    mockProcessingStatusInvalidate.mockReset();
    mockTrainingInvalidate.mockResolvedValue(undefined);
    mockProcessingStatusInvalidate.mockResolvedValue(undefined);
    mockRefreshInvalidate = undefined;
    resetMockTrainingState();
  });

  it("refreshes training data and processing status together", async () => {
    const { default: StrainScreen } = await import("./strain");
    render(<StrainScreen />);

    expect(mockRefreshInvalidate).toBeTypeOf("function");
    await mockRefreshInvalidate?.();

    expect(mockTrainingInvalidate).toHaveBeenCalledOnce();
    expect(mockProcessingStatusInvalidate).toHaveBeenCalledOnce();
  });

  it("keeps day selector visible while training data is loading", async () => {
    mockTrainingState.isLoading = true;
    mockTrainingState.data = undefined;

    const { default: StrainScreen } = await import("./strain");
    render(<StrainScreen />);

    expect(screen.getByText("30d")).toBeTruthy();
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.queryByText("Loading strain data...")).toBeNull();
  });

  it("does not report response parse errors before training data loads", async () => {
    mockTrainingState.isLoading = true;
    mockTrainingState.data = undefined;

    const { default: StrainScreen } = await import("./strain");
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
          activity_type: "cycling",
          started_at: "2026-03-28T07:00:00.000Z",
          ended_at: "2026-03-28T08:00:00.000Z",
          avg_hr: 150,
          max_hr: 178,
          avg_power: 240,
          distance_meters: 24000,
          calories: 640,
        },
      ],
    };

    const { default: StrainScreen } = await import("./strain");
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
          activity_type: "cycling",
          started_at: "2026-03-28T07:00:00.000Z",
          ended_at: "2026-03-28T08:00:00.000Z",
          avg_hr: 150,
          max_hr: 178,
          avg_power: 240,
          distance_meters: 24000,
          calories: 640,
        },
      ],
    };

    const { default: StrainScreen } = await import("./strain");
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

    const { default: StrainScreen } = await import("./strain");
    render(<StrainScreen />);

    expect(screen.getByText("Daily Strain Target")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
    expect(screen.getByText("Push")).toBeTruthy();
    expect(screen.getByText("71% reached")).toBeTruthy();
  });

  it("shows today's load separately from the rolling training load ratio", async () => {
    mockTrainingState.data = {
      strainTarget: {
        targetStrain: 12,
        currentStrain: 0,
        progressPercent: 0,
        zone: "Maintain",
        explanation:
          "Your recent training load is elevated, so today's target is capped to reduce injury risk.",
        dailyLoad: 0,
        acuteLoad: 133,
        chronicLoad: 33,
        workloadRatio: 4,
        readinessScore: 50,
      },
      workloadRatio: {
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

    const { default: StrainScreen } = await import("./strain");
    render(<StrainScreen />);

    expect(screen.getAllByText("Today").length).toBeGreaterThan(0);
    expect(screen.getByText("Training Load Ratio")).toBeTruthy();
    expect(screen.getAllByText("4.00").length).toBeGreaterThan(0);
  });

  it("does not use a prior displayed strain as today's strain fallback", async () => {
    mockTrainingState.data = {
      strainTarget: undefined,
      workloadRatio: {
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

    const { default: StrainScreen } = await import("./strain");
    render(<StrainScreen />);

    expect(screen.queryByText("13.0")).toBeNull();
    expect(screen.getAllByText("0.0").length).toBeGreaterThan(0);
  });

  it("does not render strain target card when no target data", async () => {
    const { default: StrainScreen } = await import("./strain");
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
          activity_type: "cycling",
          started_at: "2026-03-28T07:00:00.000Z",
          ended_at: "2026-03-28T08:00:00.000Z",
          avg_hr: 150,
          max_hr: 178,
          avg_power: 240,
          distance_meters: 24000,
          calories: 640,
        },
      ],
    };

    const { default: StrainScreen } = await import("./strain");
    render(<StrainScreen />);

    fireEvent.click(screen.getByText("View all"));

    expect(mockRouterPush).toHaveBeenCalledWith("/activities");
  });

  it("shows empty state and View all link when no activities exist", async () => {
    const { default: StrainScreen } = await import("./strain");
    render(<StrainScreen />);

    expect(screen.getByText("Recent Activities")).toBeTruthy();
    expect(screen.getByText("No recent activities")).toBeTruthy();
    expect(screen.getByText("View all")).toBeTruthy();
  });

  it("navigates to activities list from View all when no activities exist", async () => {
    const { default: StrainScreen } = await import("./strain");
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

    const { default: StrainScreen } = await import("./strain");
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

    const { default: StrainScreen } = await import("./strain");
    render(<StrainScreen />);

    expect(screen.getByText("Best Boulder Grade")).toBeTruthy();
    expect(screen.getByText("V4")).toBeTruthy();
    expect(screen.getByText(/strain:climbing.volumeByGrade/)).toBeTruthy();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      context: "strain:climbing.volumeByGrade",
      zodError: expect.any(Object),
    });
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

    const { default: StrainScreen } = await import("./strain");
    render(<StrainScreen />);

    expect(screen.getByText("Best Boulder Grade")).toBeTruthy();
    expect(screen.getByText("V5")).toBeTruthy();
  });

  it("renders climbing empty states from empty server arrays", async () => {
    const { default: StrainScreen } = await import("./strain");
    render(<StrainScreen />);

    expect(screen.getByText("No climbing grade progression")).toBeTruthy();
    expect(screen.getByText("No climbing volume by grade")).toBeTruthy();
    expect(screen.getByText("No climbing sessions")).toBeTruthy();
  });

  it("shows the server error message for climbing data failures", async () => {
    mockTrainingState.data = undefined;
    mockTrainingState.isError = true;
    mockTrainingState.error = new Error("Climbing data failed to load");

    const { default: StrainScreen } = await import("./strain");
    render(<StrainScreen />);

    expect(screen.getAllByText("Climbing data failed to load").length).toBeGreaterThan(0);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
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

    const { default: StrainScreen } = await import("./strain");
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

    const { default: StrainScreen } = await import("./strain");
    const firstRender = render(<StrainScreen />);
    firstRender.unmount();
    render(<StrainScreen />);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(cachedError);
  });
});
