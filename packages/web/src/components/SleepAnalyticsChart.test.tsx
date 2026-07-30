// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import type { SleepNightlyRow } from "dofek-server/types";
import { describe, expect, it, vi } from "vitest";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({ empty, emptyMessage }: { empty?: boolean; emptyMessage?: string }) => (
    <div>{empty ? emptyMessage : "Sleep analytics chart"}</div>
  ),
}));

import { SleepAnalyticsChart } from "./SleepAnalyticsChart.tsx";

const night: SleepNightlyRow = {
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
  rollingAvgDuration: 450,
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
});
