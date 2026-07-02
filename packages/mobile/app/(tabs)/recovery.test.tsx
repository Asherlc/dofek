// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockRecoveryData: Record<string, unknown> | undefined;
let mockRecoveryLoading = false;
let sparkLinePropsCalls: Record<string, unknown>[];

vi.mock("../../lib/trpc", () => ({
  trpc: {
    mobileDashboard: {
      recovery: {
        useQuery: () => ({ data: mockRecoveryData, isLoading: mockRecoveryLoading }),
      },
    },
    useUtils: () => ({
      mobileDashboard: {
        recovery: { invalidate: vi.fn() },
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
  useRouter: () => ({ push: vi.fn() }),
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
  useRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }),
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
    sparkLinePropsCalls = [];
  });

  it("keeps day selector visible while recovery data is loading", async () => {
    mockRecoveryLoading = true;

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.getByText("30d")).toBeTruthy();
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(screen.queryByText("Loading trends...")).toBeNull();
  });

  it("displays Heart Rate Variability from the recovery HRV query", async () => {
    mockRecoveryData = {
      hrvVariability: [
        { date: "2026-04-05", hrv: 50, rollingMean: 48, rollingCoefficientOfVariation: 2 },
        { date: "2026-04-06", hrv: 44, rollingMean: 44, rollingCoefficientOfVariation: 4 },
      ],
      hrvBaseline: [],
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
    expect(screen.getByText("7-day baseline: 55 bpm")).toBeTruthy();

    const restingHeartRateSparklineCall = sparkLinePropsCalls.find((sparkLineProps) => {
      const data = sparkLineProps.data;
      return Array.isArray(data) && data[0] === 56 && data[1] === 54;
    });
    expect(restingHeartRateSparklineCall).toBeDefined();
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
