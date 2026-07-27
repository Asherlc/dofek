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
  });

  it("labels weekly sleep as an average nightly value", () => {
    render(
      <WeeklyReportCard
        data={{
          current: {
            weekStart: "2026-05-24",
            trainingHours: 4,
            activityCount: 2,
            avgDailyLoad: 3,
            avgSleepMinutes: 459,
            sleepPerformancePct: 105,
            avgReadiness: 0,
            avgRestingHr: 58,
            avgHrv: 52,
          },
          history: [],
        }}
      />,
    );

    expect(screen.getByText("Avg nightly sleep")).toBeTruthy();
  });

  it("shows recent training history even when sleep was not tracked", () => {
    render(
      <WeeklyReportCard
        data={{
          current: {
            weekStart: "2026-03-17",
            trainingHours: 3,
            activityCount: 2,
            avgDailyLoad: 4,
            avgSleepMinutes: 0,
            sleepPerformancePct: 0,
            avgReadiness: 0,
            avgRestingHr: null,
            avgHrv: null,
          },
          history: [
            {
              weekStart: "2026-03-10",
              trainingHours: 2,
              activityCount: 1,
              avgDailyLoad: 3,
              avgSleepMinutes: 0,
              sleepPerformancePct: 0,
              avgReadiness: 0,
              avgRestingHr: null,
              avgHrv: null,
            },
          ],
        }}
      />,
    );

    expect(screen.getByTitle("2026-03-10: 2h 0m")).toBeTruthy();
    expect(screen.getByTitle("This week: 3h 0m")).toBeTruthy();
  });
});
