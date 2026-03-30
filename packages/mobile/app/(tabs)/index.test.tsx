// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockReadinessLoading = false;
let mockWorkloadLoading = false;
let mockSleepLoading = false;

function q(getData: () => unknown = () => undefined) {
  return { useQuery: () => ({ data: getData(), isLoading: false }) };
}

function loadableQuery(getData: () => unknown, getLoading: () => boolean) {
  return {
    useQuery: () => ({ data: getLoading() ? undefined : getData(), isLoading: getLoading() }),
  };
}

vi.mock("../../lib/trpc", () => ({
  trpc: {
    recovery: {
      readinessScore: loadableQuery(
        () => [],
        () => mockReadinessLoading,
      ),
      sleepAnalytics: loadableQuery(
        () => undefined,
        () => mockSleepLoading,
      ),
      workloadRatio: loadableQuery(
        () => [],
        () => mockWorkloadLoading,
      ),
    },
    dailyMetrics: {
      trends: { useQuery: () => ({ data: undefined, isLoading: false }) },
    },
    training: { nextWorkout: q() },
    sleepNeed: { calculate: q() },
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
  radius: { xl: 16, lg: 12, md: 8, sm: 4, full: 9999 },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  duration: { fast: 150, normal: 300, slow: 500, countUp: 800, chart: 1200, heartbeat: 3000 },
}));

describe("TodayScreen independent loading states", () => {
  beforeEach(() => {
    mockReadinessLoading = false;
    mockWorkloadLoading = false;
    mockSleepLoading = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows loading placeholder for recovery ring while readiness is loading", async () => {
    mockReadinessLoading = true;

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    // Recovery ring should show "..." loading placeholder
    expect(screen.getAllByText("...").length).toBeGreaterThanOrEqual(1);
    // Strain section should still render (not loading)
    expect(screen.getAllByText("Strain").length).toBeGreaterThanOrEqual(1);
  });

  it("shows loading placeholder for strain gauge while workload is loading", async () => {
    mockWorkloadLoading = true;

    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    // Strain gauge should show "..." loading placeholder
    expect(screen.getAllByText("...").length).toBeGreaterThanOrEqual(1);
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

  it("renders all rings when no queries are loading", async () => {
    const { default: TodayScreen } = await import("./index");
    render(<TodayScreen />);

    // All section titles should render
    expect(screen.getAllByText("Recovery").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Strain").length).toBeGreaterThanOrEqual(1);
    // No loading placeholders
    expect(screen.queryByText("...")).toBeNull();
  });
});
