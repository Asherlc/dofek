import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HangboardingSummary as HangboardingSummaryData } from "../../server/src/repositories/hangboarding-repository.ts";

const sparkLineProps = vi.hoisted(() => {
  const props: Array<Record<string, unknown>> = [];
  return props;
});

vi.mock("./charts/SparkLine", () => ({
  SparkLine: (props: Record<string, unknown>) => {
    sparkLineProps.push(props);
    return null;
  },
}));

import { HangboardingSummary } from "./HangboardingSummary";

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
  sparkLineProps.length = 0;
});

describe("HangboardingSummary", () => {
  it("renders server-provided metrics, latest metadata, and daily duration values", () => {
    render(<HangboardingSummary data={summary} loading={false} />);

    for (const label of [
      "Sessions",
      "Total Time",
      "Avg Session",
      "Work Time",
      "Rest Time",
      "Work Intervals",
      "Avg Heart Rate",
      "Peak Heart Rate",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("25m")).toBeTruthy();
    expect(screen.getByText("13m")).toBeTruthy();
    expect(screen.getByText("17s")).toBeTruthy();
    expect(screen.getByText("2m")).toBeTruthy();
    expect(screen.getByText("125 bpm")).toBeTruthy();
    expect(screen.getByText("150 bpm")).toBeTruthy();
    expect(screen.getByText("Repeaters")).toBeTruthy();
    expect(screen.getByText("Tension Board")).toBeTruthy();
    expect(screen.getByText("15m")).toBeTruthy();
    expect(screen.getByText(/2026/)).toBeTruthy();
    expect(sparkLineProps).toHaveLength(1);
    expect(sparkLineProps[0]?.data).toEqual([600, 900]);
  });

  it("renders nullable metrics and latest metadata as em dashes", () => {
    render(
      <HangboardingSummary
        data={{
          ...summary,
          totalWorkDurationSeconds: null,
          totalRestDurationSeconds: null,
          workIntervalCount: null,
          averageHeartRate: null,
          peakHeartRate: null,
          latestSession: {
            ...summary.latestSession,
            planName: null,
            boardName: null,
          },
        }}
        loading={false}
      />,
    );

    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByText("0 bpm")).toBeNull();
  });

  it("uses explicit loading and empty states", () => {
    const { rerender } = render(<HangboardingSummary data={undefined} loading={true} />);
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();

    rerender(
      <HangboardingSummary
        data={{ ...summary, sessionCount: 0, daily: [], latestSession: null }}
        loading={false}
      />,
    );
    expect(screen.getByText("No Hangboarding sessions yet.")).toBeTruthy();
  });
});
