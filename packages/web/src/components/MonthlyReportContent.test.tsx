/** @vitest-environment jsdom */

import { textColors } from "@dofek/scoring/colors";
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
          decisionSupport: {
            whatChanged: ["Monthly training increased."],
            likelyAssociations: ["Training and sleep moved together."],
            whatWorked: ["Sleep stayed consistent."],
            whatToTryNext: ["Repeat the routine next month."],
            confidenceAndMissingData: ["Confidence is limited."],
          },
          recovery: {
            range: { startDate: "2026-07-01", endDate: "2026-07-31" },
            emptyMessage: "No data found for this period.",
          },
          emptyState: {
            reportKind: "monthly",
            title: "Your monthly report will appear here",
            message: "No activity, sleep, or recovery data is available for this report yet.",
            minimumObservedDays: 1,
            acceptedDataTypes: ["activity", "sleep", "recovery"],
            requirement: "At least 1 observed day of activity, sleep, or recovery data is required to create a monthly report.",
            previewTitle: "When ready, your monthly report will include",
            previewItems: [
              "Training time and activity count",
              "Average daily strain",
              "Average sleep duration",
              "Average resting heart rate",
              "Average heart rate variability",
              "Month-over-month training and sleep changes",
            ],
            note: "This preview shows report sections only. No personal values or conclusions are estimated.",
          },
        }}
      />,
    );

    expect(screen.getByText("Current Month")).toBeTruthy();
    expect(screen.getByText("Previous Months")).toBeTruthy();
    expect(screen.getByText("July 2026")).toBeTruthy();
    expect(screen.getByText("June 2026")).toBeTruthy();
    expect(screen.getByText("+10.0%")).toBeTruthy();
    expect(screen.getByText("-2.0%")).toBeTruthy();
    expect(screen.getByText("Monthly training increased.")).toBeTruthy();
    const neutralTrendColor = `rgb(${Number.parseInt(textColors.secondary.slice(1, 3), 16)}, ${Number.parseInt(textColors.secondary.slice(3, 5), 16)}, ${Number.parseInt(textColors.secondary.slice(5, 7), 16)})`;
    expect(screen.getByText("+10.0%").style.color).toBe(neutralTrendColor);
    expect(screen.getByText("-2.0%").style.color).toBe(neutralTrendColor);
  });

  it("renders the empty state", () => {
    render(
      <MonthlyReportContent
        data={{
          current: null,
          history: [],
          decisionSupport: null,
          recovery: {
            range: { startDate: "2026-03-01", endDate: "2026-03-24" },
            emptyMessage: "No data found for this period.",
          },
          emptyState: {
            reportKind: "monthly",
            title: "Server monthly preview title",
            message: "Server monthly preview message.",
            minimumObservedDays: 1,
            acceptedDataTypes: ["activity", "sleep", "recovery"],
            requirement: "Server monthly coverage requirement.",
            previewTitle: "Server monthly structure",
            previewItems: ["Average daily strain", "Month-over-month training and sleep changes"],
            note: "Server no-estimate note.",
          },
        }}
      />,
    );

    expect(screen.getByText("Server monthly preview title")).toBeTruthy();
    expect(screen.getByText("Server monthly preview message.")).toBeTruthy();
    expect(screen.getByText("Server monthly coverage requirement.")).toBeTruthy();
    expect(screen.getByText("Server monthly structure")).toBeTruthy();
    expect(screen.getByText("Average daily strain")).toBeTruthy();
    expect(screen.getByText("Server no-estimate note.")).toBeTruthy();
  });
});
