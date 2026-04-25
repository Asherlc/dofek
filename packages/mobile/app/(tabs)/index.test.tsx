// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockReadinessLoading = false;
let mockWorkloadLoading = false;
let mockSleepLoading = false;
let mockSleepData: unknown;
let mockReadinessError: Error | null = null;
let mockWorkloadError: Error | null = null;
let mockSleepNeedError: Error | null = null;

function q(getData: () => unknown = () => undefined, getError: () => Error | null = () => null) {
  return {
    useQuery: () => ({
      data: getError() ? undefined : getData(),
      isLoading: false,
      error: getError(),
    }),
  };
}

function loadableQuery(
  getData: () => unknown,
  getLoading: () => boolean,
  getError: () => Error | null = () => null,
) {
  return {
    useQuery: () => ({
      data: getLoading() || getError() ? undefined : getData(),
      isLoading: getLoading(),
      error: getError(),
    }),
  };
}

vi.mock("../../lib/trpc", () => ({
  trpc: {
    recovery: {
      readinessScore: loadableQuery(
        () => [],
        () => mockReadinessLoading,
        () => mockReadinessError,
      ),
      sleepAnalytics: loadableQuery(
        () => mockSleepData,
        () => mockSleepLoading,
      ),
      workloadRatio: loadableQuery(
        () => [],
        () => mockWorkloadLoading,
        () => mockWorkloadError,
      ),
    },
    dailyMetrics: {
      trends: { useQuery: () => ({ data: undefined, isLoading: false }) },
    },
    training: { nextWorkout: q() },
    sleepNeed: {
      calculate: q(
        () => undefined,
        () => mockSleepNeedError,
      ),
    },
    anomalyDetection: { check: q() },
    sync: {
      triggerSync: {
        useMutation: () => ({ mutate: vi.fn() }),
      },
      activeSyncs: { useQuery: () => ({ data: [], isLoading: false }) },
    },
    useUtils: () => ({ invalidate: vi.fn() }),
  },
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

describe("TodayScreen independent loading states", () => {
  beforeEach(() => {
    mockReadinessLoading = false;
    mockWorkloadLoading = false;
    mockSleepLoading = false;
    mockSleepData = undefined;
    mockReadinessError = null;
    mockWorkloadError = null;
    mockSleepNeedError = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows skeleton placeholder for recovery ring while readiness is loading", async () => {
    mockReadinessLoading = true;

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    // Recovery ring should show skeleton circle loading placeholder
    expect(screen.getAllByTestId("skeleton-circle").length).toBeGreaterThanOrEqual(1);
    // Strain section should still render (not loading)
    expect(screen.getAllByText("Strain").length).toBeGreaterThanOrEqual(1);
  });

  it("shows skeleton placeholder for strain gauge while workload is loading", async () => {
    mockWorkloadLoading = true;

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    // Strain gauge should show skeleton circle loading placeholder
    expect(screen.getAllByTestId("skeleton-circle").length).toBeGreaterThanOrEqual(1);
    // Recovery section should still render (not loading)
    expect(screen.getAllByText("Recovery").length).toBeGreaterThanOrEqual(1);
  });

  it("hides sleep summary section while sleep analytics is loading", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    mockSleepLoading = true;

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    // Sleep summary card ("Last Night") should not render while loading
    expect(screen.queryByText("LAST NIGHT")).toBeNull();
    // Recovery and Strain should still render (not loading)
    expect(screen.getAllByText("Recovery").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Strain").length).toBeGreaterThanOrEqual(1);
  });

  it("shows last night summary when sleep data has yesterday's date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));

    mockSleepData = {
      nightly: [
        {
          date: "2026-03-20",
          durationMinutes: 480,
          sleepMinutes: 450,
          deepPct: 20,
          remPct: 25,
          lightPct: 45,
          awakePct: 10,
          efficiency: 90,
          rollingAvgDuration: 440,
        },
      ],
      sleepDebt: -30,
    };

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getByText("LAST NIGHT")).toBeTruthy();
  });

  it("renders all rings when no queries are loading", async () => {
    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    // All section titles should render
    expect(screen.getAllByText("Recovery").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Strain").length).toBeGreaterThanOrEqual(1);
    // No skeleton loading placeholders
    expect(screen.queryByTestId("skeleton-circle")).toBeNull();
  });

  it("shows a recovery error panel when the readiness query fails", async () => {
    mockReadinessError = new Error("Readiness failed");

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getByText("Readiness failed")).toBeTruthy();
    expect(screen.queryByText("No data yet")).toBeNull();
  });

  it("shows a sleep coach error card when the sleep-need query fails", async () => {
    mockSleepNeedError = new Error("Sleep coach failed");

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getByText("SLEEP COACH")).toBeTruthy();
    expect(screen.getByText("Sleep coach failed")).toBeTruthy();
  });
});
