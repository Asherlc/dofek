/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MonthlyReportContent } from "./MonthlyReportContent.tsx";

describe("MonthlyReportContent", () => {
  it("renders current and previous monthly snapshots", () => {
    render(
      <MonthlyReportContent
        data={{
          current: {
            monthStart: "2026-07-01",
            trainingHours: 20,
            activityCount: 10,
            avgDailyStrain: 8,
            avgSleepMinutes: 450,
            avgRestingHr: 55,
            avgHrv: 48,
            trainingHoursTrend: 10,
            avgSleepTrend: -2,
          },
          history: [
            {
              monthStart: "2026-06-01",
              trainingHours: 18,
              activityCount: 8,
              avgDailyStrain: 7,
              avgSleepMinutes: 460,
              avgRestingHr: 56,
              avgHrv: 45,
              trainingHoursTrend: null,
              avgSleepTrend: null,
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Current Month")).toBeTruthy();
    expect(screen.getByText("Previous Months")).toBeTruthy();
    expect(screen.getByText("July 2026")).toBeTruthy();
    expect(screen.getByText("June 2026")).toBeTruthy();
    expect(screen.getByText("+10.0%")).toBeTruthy();
    expect(screen.getByText("-2.0%")).toBeTruthy();
  });

  it("renders the empty state", () => {
    render(<MonthlyReportContent data={{ current: null, history: [] }} />);

    expect(screen.getByText("Not enough data for a monthly report yet.")).toBeTruthy();
  });
});
