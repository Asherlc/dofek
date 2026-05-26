/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WeeklyReportCard } from "./WeeklyReportCard.tsx";

describe("WeeklyReportCard", () => {
  it("shows sleep-not-tracked messaging when weekly sleep is 0 minutes", () => {
    render(
      <WeeklyReportCard
        data={{
          current: {
            weekStart: "2026-03-17",
            trainingHours: 8,
            activityCount: 5,
            strainZone: "overreaching",
            avgDailyLoad: 8,
            avgSleepMinutes: 0,
            sleepPerformancePct: 100,
            avgReadiness: 0,
            avgRestingHr: null,
            avgHrv: null,
          },
          history: [],
        }}
      />,
    );

    expect(screen.getByText("Sleep not tracked")).toBeTruthy();
    expect(screen.queryByText("Overreaching")).toBeNull();
    expect(screen.getByText("Not tracked")).toBeTruthy();
  });

  it("shows no-training status instead of optimal when the week has no activities", () => {
    render(
      <WeeklyReportCard
        data={{
          current: {
            weekStart: "2026-05-24",
            trainingHours: 0,
            activityCount: 0,
            strainZone: "optimal",
            avgDailyLoad: 0,
            avgSleepMinutes: 475,
            sleepPerformancePct: 112,
            avgReadiness: 0,
            avgRestingHr: 58,
            avgHrv: 52,
          },
          history: [],
        }}
      />,
    );

    expect(screen.getByText("No training")).toBeTruthy();
    expect(screen.queryByText("Optimal")).toBeNull();
  });
});
