// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockTrendsData: Record<string, unknown> | undefined;
let mockDailyMetricsData: Record<string, unknown>[];

function q(getData: () => unknown = () => undefined) {
  return { useQuery: () => ({ data: getData(), isLoading: false }) };
}

vi.mock("../../lib/trpc", () => ({
  trpc: {
    recovery: {
      hrvVariability: q(() => []),
      readinessScore: q(() => []),
      workloadRatio: q(() => []),
    },
    stress: { scores: q() },
    dailyMetrics: {
      trends: { useQuery: () => ({ data: mockTrendsData, isLoading: false }) },
      list: { useQuery: () => ({ data: mockDailyMetricsData, isLoading: false }) },
    },
  },
}));

vi.mock("../../lib/units", async () => {
  const actual = await vi.importActual<typeof import("../../lib/units")>("../../lib/units");
  return {
    ...actual,
    useUnitConverter: () => new actual.UnitConverter("metric"),
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
}));

describe("MetricsScreen SpO2 and Skin Temperature cards", () => {
  beforeEach(() => {
    mockTrendsData = undefined;
    mockDailyMetricsData = [];
  });

  it("renders Blood Oxygen card when latest_spo2 is present", async () => {
    mockTrendsData = { latest_spo2: 97 };
    mockDailyMetricsData = [{ spo2_avg: 96 }, { spo2_avg: 97 }];

    const { default: MetricsScreen } = await import("./metrics");
    render(<MetricsScreen />);

    expect(screen.getByText("Blood Oxygen")).toBeTruthy();
    expect(screen.getByText("97")).toBeTruthy();
    expect(screen.getByText("%")).toBeTruthy();
  });

  it("renders Skin Temperature card when latest_skin_temp is present", async () => {
    mockTrendsData = { latest_skin_temp: 36.8 };
    mockDailyMetricsData = [{ skin_temp_c: 36.6 }, { skin_temp_c: 36.8 }];

    const { default: MetricsScreen } = await import("./metrics");
    render(<MetricsScreen />);

    expect(screen.getByText("Skin Temperature")).toBeTruthy();
  });

  it("does not render Blood Oxygen card when latest_spo2 is null", async () => {
    mockTrendsData = { latest_spo2: null };
    mockDailyMetricsData = [];

    const { default: MetricsScreen } = await import("./metrics");
    render(<MetricsScreen />);

    expect(screen.queryByText("Blood Oxygen")).toBeNull();
  });

  it("does not render Skin Temperature card when latest_skin_temp is null", async () => {
    mockTrendsData = { latest_skin_temp: null };
    mockDailyMetricsData = [];

    const { default: MetricsScreen } = await import("./metrics");
    render(<MetricsScreen />);

    expect(screen.queryByText("Skin Temperature")).toBeNull();
  });
});
