// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockSleepData: Record<string, unknown> | undefined;
let mockSleepError: Error | null;

vi.mock("../lib/trpc", () => ({
  trpc: {
    recovery: {
      sleepAnalytics: {
        useQuery: () => ({
          data: mockSleepData,
          error: mockSleepError,
          isError: mockSleepError != null,
          isLoading: false,
          isFetching: false,
        }),
      },
      sleepConsistency: {
        useQuery: () => ({ data: [], isLoading: false, isFetching: false }),
      },
    },
    sleep: {
      latestStages: {
        useQuery: () => ({ data: [], isLoading: false, isFetching: false }),
      },
    },
  },
}));

vi.mock("../lib/useProcessingStatus", () => ({
  useProcessingStatus: () => ({ data: undefined, error: null, isLoading: false }),
}));

vi.mock("../lib/useRefresh", () => ({
  useRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }),
}));

vi.mock("../components/ProcessingStatusWidget", () => ({
  ProcessingStatusWidget: () => null,
}));

vi.mock("../components/charts/Hypnogram", () => ({
  Hypnogram: () => null,
}));

vi.mock("../components/charts/SleepBar", () => ({
  SleepBar: () => null,
}));

vi.mock("../components/charts/SparkLine", () => ({
  SparkLine: () => null,
}));

describe("SleepScreen", () => {
  beforeEach(() => {
    mockSleepData = undefined;
    mockSleepError = null;
  });

  it("shows the server error instead of the empty state when loading fails", async () => {
    mockSleepError = new Error("Sleep analytics are unavailable.");

    const { default: SleepScreen } = await import("./sleep");
    render(<SleepScreen />);

    expect(screen.getByText("Sleep analytics are unavailable.")).toBeTruthy();
    expect(screen.queryByText("No sleep data has been synced yet.")).toBeNull();
  });

  it("shows one truthful empty state without zero-valued summary measurements", async () => {
    mockSleepData = {
      nightly: [],
      sleepDebt: null,
      averageSleepMinutes: null,
      averageEfficiencyPercent: null,
    };

    const { default: SleepScreen } = await import("./sleep");
    render(<SleepScreen />);

    expect(screen.getByText("No sleep data has been synced yet.")).toBeTruthy();
    expect(screen.queryByText("Sleep Debt (14 Days)")).toBeNull();
    expect(screen.queryByText("No sleep debt")).toBeNull();
    expect(screen.queryByText("Average Duration")).toBeNull();
    expect(screen.queryByText("Average Efficiency")).toBeNull();
  });

  it("renders server-computed summary metrics when sleep data exists", async () => {
    mockSleepData = {
      nightly: [
        {
          date: "2026-07-20",
          startedAt: "2026-07-20T05:00:00.000Z",
          endedAt: "2026-07-20T13:00:00.000Z",
          localTimeContext: {
            timezone: null,
            startUtcOffsetMinutes: -420,
            endUtcOffsetMinutes: -420,
            source: "provider_offset",
          },
          durationMinutes: 320,
          sleepMinutes: 300,
          deepPct: 20,
          remPct: 20,
          lightPct: 50,
          awakePct: 10,
          efficiency: 50,
          rollingAvgDuration: 300,
        },
      ],
      sleepDebt: 30,
      averageSleepMinutes: 455,
      averageEfficiencyPercent: 91.2,
    };

    const { default: SleepScreen } = await import("./sleep");
    render(<SleepScreen />);

    expect(screen.getByText("0h 30m debt")).toBeTruthy();
    expect(screen.getByText("Compared with your sleep target")).toBeTruthy();
    expect(screen.queryByText("vs 8 hour target per night")).toBeNull();
    expect(screen.getByText("7h 35m")).toBeTruthy();
    expect(screen.getByText("91%")).toBeTruthy();
    expect(screen.queryByText("5h 0m")).toBeNull();
    expect(screen.queryByText("50%")).toBeNull();
  });

  it("renders the stored local bedtime and wake time", async () => {
    const today = new Intl.DateTimeFormat("en-CA").format(new Date());
    mockSleepData = {
      nightly: [
        {
          date: today,
          startedAt: `${today}T08:00:00.000Z`,
          endedAt: `${today}T16:00:00.000Z`,
          localTimeContext: {
            timezone: null,
            startUtcOffsetMinutes: -420,
            endUtcOffsetMinutes: -420,
            source: "provider_offset",
          },
          durationMinutes: 480,
          sleepMinutes: 450,
          deepPct: 20,
          remPct: 20,
          lightPct: 50,
          awakePct: 10,
          efficiency: 90,
          rollingAvgDuration: 450,
        },
      ],
      sleepDebt: 0,
      averageSleepMinutes: 450,
      averageEfficiencyPercent: 90,
    };

    const { default: SleepScreen } = await import("./sleep");
    render(<SleepScreen />);

    expect(screen.getByText("1:00 AM – 9:00 AM")).toBeTruthy();
  });
});
