// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { SleepNightlyRow } from "dofek-server/types";
import { describe, expect, it, vi } from "vitest";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({
    empty,
    emptyMessage,
    option,
  }: {
    empty?: boolean;
    emptyMessage?: string;
    option?: { series?: Array<{ data?: unknown[] }> };
  }) => (
    <div data-series-length={option?.series?.[0]?.data?.length ?? 0}>
      {empty ? emptyMessage : "Sleep analytics chart"}
    </div>
  ),
}));

import { buildSleepAnalyticsOption, SleepAnalyticsChart } from "./SleepAnalyticsChart.tsx";

const night: SleepNightlyRow = {
  providerId: null,
  sourceName: null,
  sourceProviders: [],
  selectedSessionId: null,
  overlappingSessions: [],
  date: "2026-07-20",
  startedAt: "2026-07-21T05:00:00Z",
  endedAt: "2026-07-21T13:00:00Z",
  localTimeContext: {
    timezone: "America/Los_Angeles",
    startUtcOffsetMinutes: -420,
    endUtcOffsetMinutes: -420,
    source: "provider_timezone",
  },
  durationMinutes: 480,
  sleepMinutes: 450,
  deepPct: 20,
  remPct: 20,
  lightPct: 50,
  awakePct: 10,
  efficiency: 93.8,
  stagingAvailable: true,
  rollingAvgDuration: 450,
  durationState: { status: "available" },
  sleepState: { status: "available" },
  stageState: { status: "available" },
};

describe("SleepAnalyticsChart", () => {
  it("renders the empty state when sleep summary metrics are unavailable", () => {
    render(<SleepAnalyticsChart nightly={[night]} sleepDebt={null} />);

    expect(screen.getByText("No sleep data")).toBeTruthy();
    expect(screen.queryByText("Sleep analytics chart")).toBeNull();
  });

  it("renders the chart when sleep rows and summary metrics are available", () => {
    render(<SleepAnalyticsChart nightly={[night]} sleepDebt={30} />);

    expect(screen.getByText("Sleep analytics chart")).toBeTruthy();
  });

  it("shows unavailable state when a night has duration but no plotted values", () => {
    const durationOnlyNight: SleepNightlyRow = {
      ...night,
      sleepMinutes: null,
      deepPct: null,
      remPct: null,
      lightPct: null,
      awakePct: null,
      rollingAvgDuration: null,
      stagingAvailable: false,
      sleepState: {
        status: "missing",
        reason: "Sleep stages were not reported for this night.",
        nextAction: "Sync sleep data from a source that reports sleep stages.",
      },
      stageState: {
        status: "missing",
        reason: "Sleep stages were not reported for this night.",
        nextAction: "Sync sleep data from a source that reports sleep stages.",
      },
    };

    render(<SleepAnalyticsChart nightly={[durationOnlyNight]} sleepDebt={30} />);

    expect(screen.getByText(/Sleep stages were not reported/)).toBeTruthy();
    expect(screen.queryByText("Sleep analytics chart")).toBeNull();
  });

  it("plots the same recent window used by the measured-value check", () => {
    const nightly = Array.from({ length: 15 }, (_, index) => ({
      ...night,
      date: `2026-07-${String(index + 1).padStart(2, "0")}`,
    }));

    render(<SleepAnalyticsChart nightly={nightly} sleepDebt={30} />);

    expect(screen.getByText("Sleep analytics chart")).toHaveAttribute("data-series-length", "14");
  });

  it("shows the server-authored state when every plotted sleep value is unavailable", () => {
    const unavailableNight: SleepNightlyRow = {
      ...night,
      durationMinutes: null,
      sleepMinutes: null,
      deepPct: null,
      remPct: null,
      lightPct: null,
      awakePct: null,
      rollingAvgDuration: null,
      durationState: {
        status: "missing",
        reason: "Sleep duration was not recorded.",
        nextAction: "Sync sleep data from a source that reports sleep duration.",
      },
      sleepState: {
        status: "missing",
        reason: "Sleep duration was not recorded.",
        nextAction: "Sync sleep data from a source that reports sleep duration.",
      },
      stageState: {
        status: "missing",
        reason: "Sleep stages were not reported for this night.",
        nextAction: "Sync sleep data from a source that reports sleep stages.",
      },
      stagingAvailable: false,
    };

    render(<SleepAnalyticsChart nightly={[unavailableNight]} sleepDebt={30} />);

    expect(screen.getByText(/Sleep duration was not recorded/)).toBeTruthy();
    expect(
      screen.getByText(/Sync sleep data from a source that reports sleep duration/),
    ).toBeTruthy();
    expect(screen.queryByText("Sleep analytics chart")).toBeNull();
  });

  it("does not render a missing duration as a measured zero", () => {
    const missingDurationNight: SleepNightlyRow = {
      ...night,
      durationMinutes: null,
      sleepMinutes: null,
      deepPct: 20,
      remPct: null,
      lightPct: null,
      awakePct: null,
      efficiency: null,
      rollingAvgDuration: null,
      durationState: {
        status: "missing",
        reason: "Sleep duration was not recorded.",
        nextAction: "Sync sleep data from a source that reports sleep duration.",
      },
      sleepState: {
        status: "missing",
        reason: "Sleep duration was not recorded.",
        nextAction: "Sync sleep data from a source that reports sleep duration.",
      },
      stageState: {
        status: "missing",
        reason: "Sleep stages were not reported for this night.",
        nextAction: "Sync sleep data from a source that reports sleep stages.",
      },
      stagingAvailable: false,
    };

    const option = buildSleepAnalyticsOption([missingDurationNight], 0);
    const tooltip = option.tooltip;
    if (
      typeof tooltip !== "object" ||
      tooltip === null ||
      !("formatter" in tooltip) ||
      typeof tooltip.formatter !== "function"
    ) {
      throw new Error("Expected tooltip formatter");
    }
    const formatter = tooltip.formatter;

    const html = String(
      formatter([
        {
          seriesName: "Deep",
          value: [missingDurationNight.date, 20],
          color: "#123456",
          marker: "",
          dataIndex: 0,
        },
      ]),
    );

    expect(html).toContain("Sleep duration was not recorded.");
    expect(html).toContain("Sync sleep data from a source that reports sleep duration.");
    expect(html).not.toContain("0h 0m");
    expect(html).not.toContain("Deep: 0m");
  });

  it("uses the latest missing reason from the recent summary window", () => {
    const olderUnavailableNight: SleepNightlyRow = {
      ...night,
      date: "2026-06-01",
      durationMinutes: null,
      sleepMinutes: null,
      deepPct: null,
      remPct: null,
      lightPct: null,
      awakePct: null,
      rollingAvgDuration: null,
      durationState: {
        status: "missing",
        reason: "Older sleep data is unavailable.",
        nextAction: "Review the older sleep source.",
      },
      sleepState: {
        status: "missing",
        reason: "Older sleep data is unavailable.",
        nextAction: "Review the older sleep source.",
      },
      stageState: {
        status: "missing",
        reason: "Older sleep data is unavailable.",
        nextAction: "Review the older sleep source.",
      },
    };
    const recentUnavailableNight: SleepNightlyRow = {
      ...olderUnavailableNight,
      date: "2026-07-20",
      durationState: {
        status: "missing",
        reason: "Recent sleep duration is unavailable.",
        nextAction: "Sync the recent sleep source.",
      },
      sleepState: {
        status: "missing",
        reason: "Recent sleep duration is unavailable.",
        nextAction: "Sync the recent sleep source.",
      },
      stageState: {
        status: "missing",
        reason: "Recent sleep stages are unavailable.",
        nextAction: "Sync the recent sleep source.",
      },
    };

    render(
      <SleepAnalyticsChart
        nightly={[
          olderUnavailableNight,
          ...Array.from({ length: 14 }, () => recentUnavailableNight),
        ]}
        sleepDebt={30}
      />,
    );

    expect(screen.getByText(/Recent sleep duration is unavailable/)).toBeTruthy();
    expect(screen.queryByText(/Older sleep data is unavailable/)).toBeNull();
  });
});
