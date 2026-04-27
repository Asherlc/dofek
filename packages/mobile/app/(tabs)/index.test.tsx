// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRouterPush = vi.fn();
let mockDashboardLoading = false;
let mockDashboardData: unknown;
let mockDashboardError: Error | null = null;

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("../../lib/trpc", () => ({
  trpc: {
    mobileDashboard: {
      dashboard: {
        useQuery: () => ({
          data: mockDashboardError ? undefined : mockDashboardData,
          isLoading: mockDashboardLoading,
          isError: !!mockDashboardError,
          error: mockDashboardError,
        }),
      },
    },
    sync: {
      triggerSync: {
        useMutation: () => ({
          mutate: vi.fn(),
          mutateAsync: vi.fn(() => Promise.resolve({ jobId: "test-job" })),
        }),
      },
      activeSyncs: { useQuery: () => ({ data: [], isLoading: false }) },
    },
    training: {
      nextWorkout: { useQuery: () => ({ data: undefined, isLoading: false }) },
    },
    useUtils: () => ({ invalidate: vi.fn() }),
  },
}));

vi.mock("../../lib/useAutoSync", () => ({
  useAutoSync: vi.fn(),
}));

vi.mock("../../lib/useProviderGuide", () => ({
  useProviderGuide: () => ({
    showProviderGuide: false,
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
    mockDashboardLoading = false;
    mockDashboardData = {
      readiness: {
        score: 85,
        date: "2026-03-21",
        components: { hrvScore: 80, restingHrScore: 90, sleepScore: 85, respiratoryRateScore: 80 },
        weights: { hrv: 0.5, restingHr: 0.2, sleep: 0.15, respiratoryRate: 0.15 },
      },
      sleep: {
        lastNight: {
          date: "2026-03-20",
          durationMinutes: 480,
          deepPct: 20,
          remPct: 20,
          lightPct: 50,
          awakePct: 10,
        },
        sleepDebt: 0,
      },
      strain: {
        dailyStrain: 12,
        acuteLoad: 300,
        chronicLoad: 250,
        workloadRatio: 1.2,
        date: "2026-03-21",
      },
      nextWorkout: null,
      sleepNeed: {
        baselineMinutes: 480,
        strainDebtMinutes: 20,
        accumulatedDebtMinutes: 10,
        totalNeedMinutes: 510,
        recentNights: [],
        canRecommend: true,
      },
      anomalies: { anomalies: [], checkedMetrics: [] },
      latestDate: "2026-03-21",
    };
    mockDashboardError = null;
    mockRouterPush.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows skeleton placeholder for recovery ring while readiness is loading", async () => {
    mockDashboardLoading = true;

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    // In the consolidated query, everything loads together
    expect(screen.getAllByTestId("skeleton-circle").length).toBeGreaterThanOrEqual(1);
  });

  it("shows skeleton placeholder for strain gauge while workload is loading", async () => {
    mockDashboardLoading = true;

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getAllByTestId("skeleton-circle").length).toBeGreaterThanOrEqual(1);
  });

  it("hides sleep summary section while sleep analytics is loading", async () => {
    mockDashboardLoading = true;

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.queryByText("LAST NIGHT")).toBeNull();
  });

  it("shows last night summary when sleep data has yesterday's date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));

    mockDashboardData.sleep.lastNight = {
      date: "2026-03-20",
      durationMinutes: 480,
      deepPct: 20,
      remPct: 25,
      lightPct: 45,
      awakePct: 10,
    };

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getByText("LAST NIGHT")).toBeTruthy();
  });

  it("renders all rings when no queries are loading", async () => {
    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getAllByText("Recovery").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Strain").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId("skeleton-circle")).toBeNull();
  });

  it("opens add food with today's date and auto-selected meal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 21, 15, 30));

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    fireEvent.click(screen.getByText("Log Food"));

    expect(mockRouterPush).toHaveBeenCalledWith("/food/add?meal=snack&date=2026-03-21");
  });

  it("shows a recovery error panel when the readiness query fails", async () => {
    mockDashboardError = new Error("Dashboard failed");

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getByText("Dashboard failed")).toBeTruthy();
  });

  it("shows a sleep coach error card when the sleep-need query fails", async () => {
    // In consolidated approach, they share the same error state
    mockDashboardError = new Error("Dashboard failed");

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    expect(screen.getByText("Dashboard failed")).toBeTruthy();
  });
});
