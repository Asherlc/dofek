// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockTrendsData: Record<string, unknown> | undefined;
let mockDailyMetricsData: Record<string, unknown>[];
let mockReadinessData: Record<string, unknown>[];
let sparkLinePropsCalls: Record<string, unknown>[];

function q(getData: () => unknown = () => undefined) {
  return { useQuery: () => ({ data: getData(), isLoading: false }) };
}

vi.mock("../../lib/trpc", () => ({
  trpc: {
    recovery: {
      hrvVariability: q(() => []),
      readinessScore: q(() => mockReadinessData),
      workloadRatio: q(() => []),
    },
    stress: { scores: q() },
    dailyMetrics: {
      trends: { useQuery: () => ({ data: mockTrendsData, isLoading: false }) },
      list: { useQuery: () => ({ data: mockDailyMetricsData, isLoading: false }) },
    },
    bodyAnalytics: {
      smoothedWeight: q(() => []),
      weightPrediction: q(() => ({
        ratePerWeek: null,
        rateConfidence: null,
        impliedDailyCalories: null,
        periodDeltas: { days7: null, days14: null, days30: null },
        goal: null,
        projectionLine: [],
      })),
    },
    healthspan: { score: q() },
    useUtils: () => ({ invalidate: vi.fn() }),
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
    mockTrendsData = undefined;
    mockDailyMetricsData = [];
    mockReadinessData = [];
    sparkLinePropsCalls = [];
  });

  it("renders Blood Oxygen card when latest_spo2 is present", async () => {
    mockTrendsData = { latest_spo2: 97 };
    mockDailyMetricsData = [{ spo2_avg: 96 }, { spo2_avg: 97 }];

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.getByText("Blood Oxygen")).toBeTruthy();
    expect(screen.getByText("97")).toBeTruthy();
    expect(screen.getByText("%")).toBeTruthy();
  });

  it("renders Skin Temperature card when latest_skin_temp is present", async () => {
    mockTrendsData = { latest_skin_temp: 36.8 };
    mockDailyMetricsData = [{ skin_temp_c: 36.6 }, { skin_temp_c: 36.8 }];

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.getByText("Skin Temperature")).toBeTruthy();
  });

  it("does not render Blood Oxygen card when latest_spo2 is null", async () => {
    mockTrendsData = { latest_spo2: null };
    mockDailyMetricsData = [];

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.queryByText("Blood Oxygen")).toBeNull();
  });

  it("does not render Skin Temperature card when latest_skin_temp is null", async () => {
    mockTrendsData = { latest_skin_temp: null };
    mockDailyMetricsData = [];

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    expect(screen.queryByText("Skin Temperature")).toBeNull();
  });

  it("expands recovery breakdown when recovery card is tapped", async () => {
    mockReadinessData = [
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
    ];

    const { default: RecoveryScreen } = await import("./recovery");
    render(<RecoveryScreen />);

    // Breakdown weight labels should not be visible initially
    expect(screen.queryByText("50%")).toBeNull();
    expect(screen.queryByText("Resting Heart Rate")).toBeNull();

    // Tap the recovery score to expand
    fireEvent.click(screen.getByText("75"));

    // Component breakdown with weight percentages should now be visible
    expect(screen.getByText("50%")).toBeTruthy(); // HRV weight
    expect(screen.getByText("20%")).toBeTruthy(); // RHR weight
    expect(screen.getByText("Resting Heart Rate")).toBeTruthy();
    expect(screen.getByText("Respiratory Rate")).toBeTruthy();
  });

  it("renders recovery score trend with neutral line and threshold bands", async () => {
    mockReadinessData = [
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
    ];

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
