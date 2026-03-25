// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockTrendsData: Record<string, unknown> | undefined;
let mockDailyMetricsData: Record<string, unknown>[];
let mockReadinessLoading = false;
let mockWorkloadLoading = false;
let mockSleepLoading = false;

function q(getData: () => unknown = () => undefined) {
  return { useQuery: () => ({ data: getData(), isLoading: false }) };
}

function loadableQuery(getData: () => unknown, getLoading: () => boolean) {
  return { useQuery: () => ({ data: getLoading() ? undefined : getData(), isLoading: getLoading() }) };
}

vi.mock("../../lib/trpc", () => ({
  trpc: {
    recovery: {
      readinessScore: loadableQuery(() => [], () => mockReadinessLoading),
      sleepAnalytics: loadableQuery(() => undefined, () => mockSleepLoading),
      workloadRatio: loadableQuery(() => [], () => mockWorkloadLoading),
      hrvVariability: q(() => []),
    },
    stress: { scores: q() },
    activity: { list: q(() => ({ items: [], totalCount: 0 })) },
    dailyMetrics: {
      trends: { useQuery: () => ({ data: mockTrendsData, isLoading: false }) },
      list: { useQuery: () => ({ data: mockDailyMetricsData, isLoading: false }) },
    },
    weeklyReport: { report: q() },
    training: { nextWorkout: q() },
    sleepNeed: { calculate: q() },
    healthspan: { score: q() },
    nutrition: { daily: q(() => []) },
    bodyAnalytics: { smoothedWeight: q(() => []) },
    anomalyDetection: { check: q() },
    sync: {
      triggerSync: { useMutation: () => ({ mutateAsync: vi.fn().mockResolvedValue({ jobId: "auto-sync-job" }) }) },
      activeSyncs: { useQuery: () => ({ data: [], isLoading: false }) },
    },
    useUtils: () => ({
      invalidate: vi.fn(),
      client: {
        healthKitSync: {
          pushQuantitySamples: { mutate: vi.fn().mockResolvedValue({ inserted: 0, errors: [] }) },
          pushWorkouts: { mutate: vi.fn().mockResolvedValue({ inserted: 0 }) },
          pushSleepSamples: { mutate: vi.fn().mockResolvedValue({ inserted: 0 }) },
        },
      },
      sync: {
        syncStatus: { fetch: vi.fn().mockResolvedValue({ status: "done", providers: {} }) },
      },
    }),
  },
}));

vi.mock("../../modules/health-kit", () => ({
  isAvailable: () => false,
  getRequestStatus: vi.fn().mockResolvedValue("unavailable"),
  queryDailyStatistics: vi.fn().mockResolvedValue([]),
  queryQuantitySamples: vi.fn().mockResolvedValue([]),
  queryWorkouts: vi.fn().mockResolvedValue([]),
  querySleepSamples: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/useOnboarding", () => ({
  useOnboarding: () => ({
    showOnboarding: false,
    dismiss: vi.fn(),
    isLoading: false,
    providers: [],
  }),
}));

vi.mock("../../lib/units", async () => {
  const actual = await vi.importActual<typeof import("../../lib/units")>("../../lib/units");
  return {
    ...actual,
    useUnitConverter: () => new actual.UnitConverter("metric"),
  };
});

vi.mock("../../types/api", () => ({
  ActivityRowSchema: { array: () => ({ catch: () => ({ parse: () => [] }) }) },
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
  statusColors: {
    positive: "#0f0",
    warning: "#ff0",
    danger: "#f00",
    info: "#0af",
  },
}));

describe("Health Status title", () => {
  beforeEach(() => {
    mockTrendsData = undefined;
    mockDailyMetricsData = [];
    mockReadinessLoading = false;
    mockWorkloadLoading = false;
    mockSleepLoading = false;
  });

  it("always shows 'Health Status' regardless of data date", async () => {
    mockTrendsData = { latest_date: "2026-03-20", latest_steps: 2895 };

    const { default: OverviewScreen } = await import("./index");
    render(<OverviewScreen />);

    expect(screen.getByText("Health Status")).toBeDefined();
  });
});

describe("OverviewScreen SpO2 and Skin Temperature cards", () => {
  beforeEach(() => {
    mockTrendsData = undefined;
    mockDailyMetricsData = [];
    mockReadinessLoading = false;
    mockWorkloadLoading = false;
    mockSleepLoading = false;
  });

  it("renders Blood Oxygen card when latest_spo2 is present", async () => {
    mockTrendsData = { latest_spo2: 98 };
    mockDailyMetricsData = [{ spo2_avg: 97 }, { spo2_avg: 98 }];

    const { default: OverviewScreen } = await import("./index");
    render(<OverviewScreen />);

    // May appear in both key metrics and Health Status Bar
    expect(screen.getAllByText("Blood Oxygen").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("98").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("%").length).toBeGreaterThanOrEqual(1);
  });

  it("renders Skin Temperature card when latest_skin_temp is present", async () => {
    mockTrendsData = { latest_skin_temp: 36.5 };
    mockDailyMetricsData = [{ skin_temp_c: 36.3 }, { skin_temp_c: 36.5 }];

    const { default: OverviewScreen } = await import("./index");
    render(<OverviewScreen />);

    expect(screen.getAllByText("Skin Temperature").length).toBeGreaterThanOrEqual(1);
  });

  it("does not render Blood Oxygen key metrics card when latest_spo2 is null", async () => {
    mockTrendsData = { latest_spo2: null };
    mockDailyMetricsData = [];

    const { default: OverviewScreen } = await import("./index");
    render(<OverviewScreen />);

    // The key metrics card (with the large value) should not render when null,
    // but the Health Status Bar mini-metric still shows the label with "--" fallback
    const elements = screen.queryAllByText("Blood Oxygen");
    // Should only appear in the Health Status Bar, not as a key metrics card
    expect(elements.length).toBeLessThanOrEqual(1);
  });

  it("does not render Skin Temperature key metrics card when latest_skin_temp is null", async () => {
    mockTrendsData = { latest_skin_temp: null };
    mockDailyMetricsData = [];

    const { default: OverviewScreen } = await import("./index");
    render(<OverviewScreen />);

    // Same as above — only the Health Status Bar mini-metric should appear
    const elements = screen.queryAllByText("Skin Temperature");
    expect(elements.length).toBeLessThanOrEqual(1);
  });
});

describe("OverviewScreen independent loading states", () => {
  beforeEach(() => {
    mockTrendsData = undefined;
    mockDailyMetricsData = [];
    mockReadinessLoading = false;
    mockWorkloadLoading = false;
    mockSleepLoading = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows loading placeholder for recovery ring while readiness is loading", async () => {
    mockReadinessLoading = true;

    const { default: OverviewScreen } = await import("./index");
    render(<OverviewScreen />);

    // Recovery ring should show "..." loading placeholder
    expect(screen.getAllByText("...").length).toBeGreaterThanOrEqual(1);
    // Strain section should still render (not loading)
    expect(screen.getAllByText("Strain").length).toBeGreaterThanOrEqual(1);
  });

  it("shows loading placeholder for strain gauge while workload is loading", async () => {
    mockWorkloadLoading = true;

    const { default: OverviewScreen } = await import("./index");
    render(<OverviewScreen />);

    // Strain gauge should show "..." loading placeholder
    expect(screen.getAllByText("...").length).toBeGreaterThanOrEqual(1);
    // Recovery section should still render (not loading)
    expect(screen.getAllByText("Recovery").length).toBeGreaterThanOrEqual(1);
  });

  it("hides sleep summary section while sleep analytics is loading", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    mockSleepLoading = true;

    const { default: OverviewScreen } = await import("./index");
    render(<OverviewScreen />);

    // Sleep summary card ("Last Night") should not render while loading
    expect(screen.queryByText("Last Night")).toBeNull();
    // Recovery and Strain should still render (not loading)
    expect(screen.getAllByText("Recovery").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Strain").length).toBeGreaterThanOrEqual(1);
  });

  it("renders all rings when no queries are loading", async () => {
    const { default: OverviewScreen } = await import("./index");
    render(<OverviewScreen />);

    // All section titles should render
    expect(screen.getAllByText("Recovery").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Strain").length).toBeGreaterThanOrEqual(1);
    // No loading placeholders
    expect(screen.queryByText("...")).toBeNull();
  });
});
