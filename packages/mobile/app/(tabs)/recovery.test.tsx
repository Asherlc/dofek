// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockRecoveryData: Record<string, unknown> | undefined;
let mockRecoveryLoading = false;
let mockRecoveryFetching = false;
let sparkLinePropsCalls: Record<string, unknown>[];
const mockRecoveryInvalidate = vi.fn();
const mockProcessingStatusInvalidate = vi.fn();
const mockRouterPush = vi.fn();
let mockRefreshInvalidate: (() => Promise<void> | void) | null | undefined;

function baselineMetric(
  metric: "hrv" | "resting_heart_rate" | "respiratory_rate" | "sleep_efficiency",
  value: number,
) {
  return {
    metric,
    label: metric,
    value,
    baseline: {
      windowDays: 30,
      mean: 50,
      standardDeviation: 5,
      zScore: 1,
      sampleCount: 24,
      coverage: 0.8,
    },
    comparison: {
      recentDays: 7,
      baselineDays: 28,
      recentMean: 52,
      baselineMean: 50,
      delta: 2,
      direction: "increasing",
    },
  };
}

vi.mock("../../lib/trpc", () => ({
  trpc: {
    mobileDashboard: {
      recovery: {
        useQuery: () => ({
          data:
            mockRecoveryData == null
              ? undefined
              : { baselineRelative: [], healthStatus: [], ...mockRecoveryData },
          isLoading: mockRecoveryLoading,
          isFetching: mockRecoveryFetching,
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
        recovery: { invalidate: mockRecoveryInvalidate },
      },
      processing: {
        status: { invalidate: mockProcessingStatusInvalidate },
      },
    }),
  },
}));

vi.mock("../../components/charts/SparkLine", () => ({
  SparkLine: (props: Record<string, unknown>) => {
    sparkLinePropsCalls.push(props);
    return <div data-testid="sparkline-mock" />;
  },
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("../../lib/units", async () => {
  const { UnitConverter } = await import("@dofek/format/units");
  const actual = await vi.importActual<typeof import("../../lib/units")>("../../lib/units");
  return {
    ...actual,
    useUnitConverter: () => new UnitConverter("metric"),
  };
});

vi.mock("../../lib/useRefresh", () => ({
  useRefresh: (input: { invalidate?: (() => Promise<void> | void) | null }) => {
    mockRefreshInvalidate = input.invalidate;
    return { refreshing: false, onRefresh: vi.fn() };
  },
}));

vi.mock("../../theme", () => ({
  colors: {
    background: "#000",
    surface: "#1a1a1a",
    surfaceSecondary: "#2a2a2a",
    accent: "#0af",
    text: "#fff",
    textSecondary: "#999",
    textTertiary: "#666",
    danger: "#f00",
    positive: "#0f0",
    warning: "#ff0",
    teal: "#0ff",
    purple: "#a0f",
    blue: "#00f",
    green: "#0f0",
    orange: "#f80",
  },
  radius: { xl: 16, lg: 12, md: 8, sm: 4, full: 9999 },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  duration: { fast: 150, normal: 300, slow: 500, countUp: 800, chart: 1200, heartbeat: 3000 },
}));

describe("RecoveryScreen SpO2 and Skin Temperature cards", () => {
  beforeEach(() => {
    mockRecoveryData = undefined;
    mockRecoveryLoading = false;
    mockRecoveryFetching = false;
    sparkLinePropsCalls = [];
    mockRecoveryInvalidate.mockReset();
    mockProcessingStatusInvalidate.mockReset();
    mockRouterPush.mockReset();
    mockRecoveryInvalidate.mockResolvedValue(undefined);
    mockProcessingStatusInvalidate.mockResolvedValue(undefined);
    mockRefreshInvalidate = undefined;
  });

  it("refreshes recovery data and processing status together", async () => {
    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(mockRefreshInvalidate).toBeTypeOf("function");
    await mockRefreshInvalidate?.();

    expect(mockRecoveryInvalidate).toHaveBeenCalledOnce();
    expect(mockProcessingStatusInvalidate).toHaveBeenCalledOnce();
  });

  it("opens breathwork from recovery tools", async () => {
    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Breathwork" }));

    expect(mockRouterPush).toHaveBeenCalledWith("/breathwork");
  });

  it("opens behavior associations from recovery tools", async () => {
    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Behavior Associations" }));

    expect(mockRouterPush).toHaveBeenCalledWith("/behavior-associations");
  });

  it("keeps day selector visible while recovery data is loading", async () => {
    mockRecoveryLoading = true;

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.getByText("30d")).toBeTruthy();
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.queryByText("Loading trends...")).toBeNull();
  });

  it("keeps cached recovery data visible while refreshing", async () => {
    mockRecoveryLoading = true;
    mockRecoveryFetching = true;
    mockRecoveryData = {
      hrvVariability: [
        { date: "2026-04-05", hrv: 50, rollingMean: 48, rollingCoefficientOfVariation: 2 },
        { date: "2026-04-06", hrv: 44, rollingMean: 44, rollingCoefficientOfVariation: 4 },
      ],
      hrvBaseline: [],
      baselineRelative: [baselineMetric("hrv", 44)],
      readinessScore: [],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: null,
      dailyMetrics: [],
      weight: [],
      healthspan: { healthspanScore: null, metrics: [], trend: null },
    };

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.queryByTestId("query-state-loading")).toBeNull();
    expect(screen.getByText("Heart Rate Variability")).toBeTruthy();
    expect(screen.getByText("44 ms")).toBeTruthy();
  });

  it("displays Heart Rate Variability from the recovery HRV query", async () => {
    mockRecoveryData = {
      hrvVariability: [
        { date: "2026-04-05", hrv: 50, rollingMean: 48, rollingCoefficientOfVariation: 2 },
        { date: "2026-04-06", hrv: 44, rollingMean: 44, rollingCoefficientOfVariation: 4 },
      ],
      hrvBaseline: [],
      baselineRelative: [baselineMetric("hrv", 44)],
      readinessScore: [],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: { latest_spo2: 24, latest_skin_temp: null },
      dailyMetrics: [],
      weight: [],
      healthspan: { healthspanScore: null, metrics: [], trend: null },
    };

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.getByText("Heart Rate Variability")).toBeTruthy();
    expect(screen.getByText("44 ms")).toBeTruthy();
    expect(screen.queryByText("24")).toBeNull();
  });

  it("displays Resting Heart Rate from the baseline query", async () => {
    mockRecoveryData = {
      hrvVariability: [],
      hrvBaseline: [
        {
          date: "2026-04-05",
          hrv: 50,
          resting_hr: 56,
          resting_hr_mean_7d: 57,
        },
        {
          date: "2026-04-06",
          hrv: 44,
          resting_hr: 54,
          resting_hr_mean_7d: 55,
        },
      ],
      baselineRelative: [baselineMetric("resting_heart_rate", 54)],
      readinessScore: [],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: null,
      dailyMetrics: [],
      weight: [],
      healthspan: { healthspanScore: null, metrics: [], trend: null },
    };

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.getByText("Resting Heart Rate")).toBeTruthy();
    expect(screen.getByText("54")).toBeTruthy();
    expect(
      screen.getByText(
        "30d baseline 50.0 bpm ± 5.0 bpm · 1.0 SD above baseline · 7d vs prior 28d +2.0 bpm · 24/30 baseline days",
      ),
    ).toBeTruthy();

    const restingHeartRateSparklineCall = sparkLinePropsCalls.find((sparkLineProps) => {
      const data = sparkLineProps.data;
      return Array.isArray(data) && data[0] === 56 && data[1] === 54;
    });
    expect(restingHeartRateSparklineCall).toBeDefined();
  });

  it("opens contributing heart-rate readings from the resting-heart-rate card", async () => {
    mockRecoveryData = {
      hrvVariability: [],
      hrvBaseline: [
        {
          date: "2026-04-06",
          hrv: 44,
          resting_hr: 54,
          resting_hr_mean_7d: 55,
        },
      ],
      baselineRelative: [baselineMetric("resting_heart_rate", 54)],
      readinessScore: [],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: null,
      dailyMetrics: [],
      weight: [],
      healthspan: { healthspanScore: null, metrics: [], trend: null },
    };

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    fireEvent.click(screen.getByRole("button", { name: "View data for Resting Heart Rate" }));

    expect(mockRouterPush).toHaveBeenCalledWith("/daily-heart-rate");
  });

  it("displays respiratory rate and sleep efficiency with canonical baseline context", async () => {
    mockRecoveryData = {
      hrvVariability: [],
      hrvBaseline: [],
      baselineRelative: [
        baselineMetric("respiratory_rate", 14),
        baselineMetric("sleep_efficiency", 90),
      ],
      readinessScore: [],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: null,
      dailyMetrics: [],
      weight: [],
      healthspan: { healthspanScore: null, metrics: [], trend: null },
    };

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.getByText("Respiratory Rate")).toBeTruthy();
    expect(screen.getByText("14.0")).toBeTruthy();
    expect(screen.getByText("Sleep Efficiency")).toBeTruthy();
    expect(screen.getByText("90.0")).toBeTruthy();
    expect(screen.getAllByText(/24\/30 baseline days/)).toHaveLength(2);
  });

  it("opens contributing nights from the sleep-efficiency card", async () => {
    mockRecoveryData = {
      hrvVariability: [],
      hrvBaseline: [],
      baselineRelative: [baselineMetric("sleep_efficiency", 90)],
      readinessScore: [],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: null,
      dailyMetrics: [],
      weight: [],
      healthspan: { healthspanScore: null, metrics: [], trend: null },
    };

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    fireEvent.click(screen.getByRole("button", { name: "View data for Sleep Efficiency" }));

    expect(mockRouterPush).toHaveBeenCalledWith("/sleep");
  });

  it("renders Blood Oxygen card when latest_spo2 is present", async () => {
    mockRecoveryData = {
      hrvVariability: [],
      hrvBaseline: [],
      readinessScore: [],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: { latest_spo2: 97, latest_skin_temp: null },
      dailyMetrics: [{ spo2_avg: 96 }, { spo2_avg: 97 }],
      weight: [],
      healthspan: { healthspanScore: null, metrics: [], trend: null },
    };

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.getByText("Blood Oxygen")).toBeTruthy();
    expect(screen.getByText("97%")).toBeTruthy();
  });

  it("renders Skin Temperature card when latest_skin_temp is present", async () => {
    mockRecoveryData = {
      hrvVariability: [],
      hrvBaseline: [],
      readinessScore: [],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: { latest_spo2: null, latest_skin_temp: 36.8 },
      dailyMetrics: [{ skin_temp_c: 36.6 }, { skin_temp_c: 36.8 }],
      weight: [],
      healthspan: { healthspanScore: null, metrics: [], trend: null },
    };

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.getByText("Skin Temperature")).toBeTruthy();
  });

  it("does not render Blood Oxygen card when latest_spo2 is null", async () => {
    mockRecoveryData = {
      hrvVariability: [],
      hrvBaseline: [],
      readinessScore: [],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: { latest_spo2: null, latest_skin_temp: null },
      dailyMetrics: [],
      weight: [],
      healthspan: { healthspanScore: null, metrics: [], trend: null },
    };

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.queryByText("Blood Oxygen")).toBeNull();
  });

  it("does not render Skin Temperature card when latest_skin_temp is null", async () => {
    mockRecoveryData = {
      hrvVariability: [],
      hrvBaseline: [],
      readinessScore: [],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: { latest_spo2: null, latest_skin_temp: null },
      dailyMetrics: [],
      weight: [],
      healthspan: { healthspanScore: null, metrics: [], trend: null },
    };

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.queryByText("Skin Temperature")).toBeNull();
  });

  it("labels smoothed body weight as Trend Weight and shows the latest scale reading", async () => {
    mockRecoveryData = {
      hrvVariability: [],
      hrvBaseline: [],
      readinessScore: [],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: null,
      dailyMetrics: [],
      weight: [
        {
          date: "2026-04-05",
          rawWeight: 80.2,
          smoothedWeight: 79.8,
          weeklyChange: null,
          interpolated: false,
        },
        {
          date: "2026-04-06",
          rawWeight: 80,
          smoothedWeight: 79.8,
          weeklyChange: null,
          interpolated: false,
        },
      ],
      healthspan: { healthspanScore: null, metrics: [], trend: null },
    };

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.getByText("TREND WEIGHT")).toBeTruthy();
    expect(screen.getByText("79.8 kg")).toBeTruthy();
    expect(screen.getByText("Scale: 80.0 kg")).toBeTruthy();
    expect(
      screen.getByText("Moves 10% toward each day's scale weight; gaps are interpolated."),
    ).toBeTruthy();
  });

  it("uses neutral text for weight-rate direction", async () => {
    mockRecoveryData = {
      hrvVariability: [],
      hrvBaseline: [],
      readinessScore: [],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: null,
      dailyMetrics: [],
      weight: [
        {
          date: "2026-04-06",
          rawWeight: 80,
          smoothedWeight: 79.8,
          weeklyChange: null,
          interpolated: false,
        },
      ],
      weightPrediction: {
        ratePerWeek: -0.3,
        rateConfidence: 0.92,
        impliedDailyCalories: -330,
        periodDeltas: { days7: null, days14: null, days30: null },
        goal: null,
        projectionLine: [],
      },
      healthspan: { healthspanScore: null, metrics: [], trend: null },
    };

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.getByText("-0.3 kg/wk").style.color).toBe("rgb(153, 153, 153)");
  });

  it("expands recovery breakdown when recovery card is tapped", async () => {
    mockRecoveryData = {
      hrvVariability: [],
      hrvBaseline: [],
      readinessScore: [
        {
          date: "2026-04-05",
          readinessScore: 72,
          components: {
            hrvScore: 80,
            restingHrScore: 65,
            sleepScore: 70,
            respiratoryRateScore: 60,
          },
          weights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
        },
        {
          date: "2026-04-06",
          readinessScore: 75,
          components: {
            hrvScore: 82,
            restingHrScore: 68,
            sleepScore: 72,
            respiratoryRateScore: 63,
          },
          weights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
        },
      ],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: null,
      dailyMetrics: [],
      weight: [],
      healthspan: { healthspanScore: null, metrics: [], trend: null },
    };

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.queryByText("50%")).toBeNull();
    expect(screen.queryByText("Respiratory Rate")).toBeNull();

    fireEvent.click(screen.getByText("75"));

    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("20%")).toBeTruthy();
    expect(screen.getAllByText("Resting Heart Rate").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Respiratory Rate")).toBeTruthy();
  });

  it("renders recovery score trend with neutral line and threshold bands", async () => {
    mockRecoveryData = {
      hrvVariability: [],
      hrvBaseline: [],
      readinessScore: [
        {
          date: "2026-03-29",
          readinessScore: 58,
          components: {
            hrvScore: 60,
            restingHrScore: 55,
            sleepScore: 62,
            respiratoryRateScore: 57,
          },
          weights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
        },
        {
          date: "2026-03-30",
          readinessScore: 78,
          components: {
            hrvScore: 80,
            restingHrScore: 76,
            sleepScore: 77,
            respiratoryRateScore: 79,
          },
          weights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
        },
      ],
      stress: { daily: [], weekly: [], latestScore: null, trend: "stable" },
      trends: null,
      dailyMetrics: [],
      weight: [],
      healthspan: { healthspanScore: null, metrics: [], trend: null },
    };

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    const readinessSparklineCall = sparkLinePropsCalls.find((sparkLineProps) => {
      const domain = sparkLineProps.domain;
      if (typeof domain !== "object" || domain == null) return false;
      if (!("min" in domain) || !("max" in domain)) return false;
      return domain.min === 0 && domain.max === 100;
    });

    expect(readinessSparklineCall).toBeDefined();
    expect(readinessSparklineCall?.color).toBe("#999");
    expect(readinessSparklineCall?.backgroundBands).toEqual([
      { min: 0, max: 50, color: "#f0020" },
      { min: 50, max: 70, color: "#ff020" },
      { min: 70, max: 100, color: "#0f020" },
    ]);
  });
});
