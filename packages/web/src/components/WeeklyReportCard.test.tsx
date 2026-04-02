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
});
