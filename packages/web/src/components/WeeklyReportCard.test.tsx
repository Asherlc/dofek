/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { createReportEmptyState } from "dofek-server/report-empty-state";
import { afterEach, describe, expect, it } from "vitest";
import { WeeklyReportCard } from "./WeeklyReportCard.tsx";

afterEach(() => {
  cleanup();
});

describe("WeeklyReportCard", () => {
  it("previews the server-owned weekly report structure without values", () => {
    render(
      <WeeklyReportCard
        data={{
          current: null,
          history: [],
          emptyState: {
            reportKind: "weekly",
            title: "Server weekly preview title",
            message: "Server weekly preview message.",
            minimumObservedDays: 1,
            acceptedDataTypes: ["activity", "sleep", "recovery"],
            requirement: "Server weekly coverage requirement.",
            previewTitle: "Server weekly structure",
            previewItems: ["Training time and activity count", "Average nightly sleep"],
            note: "Server no-estimate note.",
          },
          decisionSupport: null,
        }}
      />,
    );

    expect(screen.getByText("Server weekly preview title")).toBeTruthy();
    expect(screen.getByText("Server weekly preview message.")).toBeTruthy();
    expect(screen.getByText("Server weekly coverage requirement.")).toBeTruthy();
    expect(screen.getByText("Server weekly structure")).toBeTruthy();
    expect(screen.getByText("Training time and activity count")).toBeTruthy();
    expect(screen.getByText("Server no-estimate note.")).toBeTruthy();
  });

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
          decisionSupport: {
            whatChanged: ["Weekly training increased."],
            likelyAssociations: ["Training and sleep moved together."],
            whatWorked: ["Sleep stayed consistent."],
            whatToTryNext: ["Repeat the routine next week."],
            confidenceAndMissingData: ["Confidence is limited."],
          },
          emptyState: createReportEmptyState("weekly"),
        }}
      />,
    );

    expect(screen.getByText("Sleep not tracked")).toBeTruthy();
    expect(screen.getByText("Not tracked")).toBeTruthy();
    expect(screen.getByText("Weekly training increased.")).toBeTruthy();
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
          decisionSupport: null,
          emptyState: createReportEmptyState("weekly"),
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
          decisionSupport: null,
          emptyState: createReportEmptyState("weekly"),
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
          decisionSupport: null,
          emptyState: createReportEmptyState("weekly"),
        }}
      />,
    );

    expect(screen.getByTitle("2026-03-10: 2h 0m")).toBeTruthy();
    expect(screen.getByTitle("This week: 3h 0m")).toBeTruthy();
  });
});
