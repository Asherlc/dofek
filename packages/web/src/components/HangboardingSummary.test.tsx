/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HangboardingSummary as HangboardingSummaryData } from "../../../server/src/repositories/hangboarding-repository.ts";

const chart = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    to,
  }: {
    children: React.ReactNode;
    params?: { id?: string };
    to: string;
  }) => <a href={params?.id ? `/activity/${params.id}` : to}>{children}</a>,
}));

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: (props: { option: Record<string, unknown> }) => {
    chart(props);
    return <div data-testid="hangboarding-daily-chart" />;
  },
}));

import { HangboardingSummary } from "./HangboardingSummary.tsx";

const summary: HangboardingSummaryData = {
  sessionCount: 2,
  totalDurationSeconds: 1500,
  averageDurationSeconds: 750,
  totalWorkDurationSeconds: 17,
  totalRestDurationSeconds: 103,
  workIntervalCount: 2,
  averageHeartRate: 125,
  peakHeartRate: 150,
  latestSession: {
    activityId: "activity-2",
    startedAt: "2026-08-08T14:00:00.000Z",
    planName: "Repeaters",
    boardName: "Tension Board",
    durationSeconds: 900,
  },
  daily: [
    {
      date: "2026-08-07",
      sessionCount: 1,
      durationSeconds: 600,
      workDurationSeconds: 7,
      restDurationSeconds: 53,
    },
    {
      date: "2026-08-08",
      sessionCount: 1,
      durationSeconds: 900,
      workDurationSeconds: 10,
      restDurationSeconds: 50,
    },
  ],
};

afterEach(() => {
  cleanup();
  chart.mockReset();
});

describe("HangboardingSummary", () => {
  it("renders server-provided summary metrics and latest-session metadata", () => {
    render(<HangboardingSummary data={summary} loading={false} />);

    for (const label of [
      "Sessions",
      "Total Time",
      "Avg Session",
      "Work Time",
      "Rest Time",
      "Peak Heart Rate",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("25m")).toBeTruthy();
    expect(screen.getByText("13m")).toBeTruthy();
    expect(screen.getByText("17s")).toBeTruthy();
    expect(screen.getByText("2m")).toBeTruthy();
    expect(screen.getByText("150 bpm")).toBeTruthy();
    expect(screen.getByText("Repeaters")).toBeTruthy();
    const latestSessionLink = screen.getByRole("link", { name: /Repeaters.*Tension Board/ });
    expect(latestSessionLink).toHaveAttribute("href", "/activity/activity-2");
  });

  it("renders nullable work, rest, and heart-rate values as em dashes", () => {
    render(
      <HangboardingSummary
        data={{
          ...summary,
          totalWorkDurationSeconds: null,
          totalRestDurationSeconds: null,
          peakHeartRate: null,
        }}
        loading={false}
      />,
    );

    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(screen.queryByText("0s")).toBeNull();
    expect(screen.queryByText("0 bpm")).toBeNull();
  });

  it("uses the query-state loading convention before data is available", () => {
    render(<HangboardingSummary data={undefined} loading={true} />);

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
  });

  it("renders an explicit empty state when there are no sessions", () => {
    render(
      <HangboardingSummary
        data={{ ...summary, sessionCount: 0, daily: [], latestSession: null }}
        loading={false}
      />,
    );

    expect(screen.getByText("No Hangboarding sessions yet.")).toBeTruthy();
  });
});
