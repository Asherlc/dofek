/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const monthlyQueryControl = vi.hoisted(() => ({
  showError: false,
  preserveData: false,
  showDecisionSupport: true,
}));
const mockWeeklyReportQuery = vi.hoisted(() => vi.fn());
const mockMonthlyReportQuery = vi.hoisted(() => vi.fn());

vi.mock("../components/HealthReportShareButton", () => ({
  HealthReportShareButton: ({ input }: { input: { reportType: string } }) => (
    <button type="button">Share {input.reportType} report</button>
  ),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    weeklyReport: {
      report: {
        useQuery: (...args: unknown[]) => {
          mockWeeklyReportQuery(...args);
          return {
            data: {
              current: {
                weekStart: "2026-07-19",
                trainingHours: 5,
                activityCount: 3,
                avgDailyLoad: 4,
                avgSleepMinutes: 450,
                sleepPerformancePct: 100,
                avgReadiness: 0,
                avgRestingHr: 55,
                avgHrv: 48,
              },
              history: [],
              decisionSupport: monthlyQueryControl.showDecisionSupport
                ? {
                    whatChanged: ["Weekly training increased."],
                    likelyAssociations: ["Training and sleep moved together."],
                    whatWorked: ["Sleep stayed consistent."],
                    whatToTryNext: ["Repeat the routine next week."],
                    confidenceAndMissingData: ["Confidence is limited."],
                  }
                : null,
            },
            isLoading: false,
            error: null,
          };
        },
      },
    },
    monthlyReport: {
      report: {
        useQuery: (...args: unknown[]) => {
          mockMonthlyReportQuery(...args);
          return {
            data:
              monthlyQueryControl.showError && !monthlyQueryControl.preserveData
                ? undefined
                : {
                    current: {
                      monthStart: "2026-07-01",
                      trainingHours: 20,
                      activityCount: 10,
                      avgDailyStrain: 8,
                      avgSleepMinutes: 450,
                      avgRestingHr: 55,
                      avgHrv: 48,
                      trainingHoursTrend: null,
                      avgSleepTrend: null,
                    },
                    history: [],
                    decisionSupport: monthlyQueryControl.showDecisionSupport
                      ? {
                          whatChanged: ["Monthly training increased."],
                          likelyAssociations: ["Training and sleep moved together."],
                          whatWorked: ["Sleep stayed consistent."],
                          whatToTryNext: ["Repeat the routine next month."],
                          confidenceAndMissingData: ["Confidence is limited."],
                        }
                      : null,
                  },
            isLoading: false,
            error: monthlyQueryControl.showError
              ? new Error("Monthly report service unavailable")
              : null,
          };
        },
      },
    },
  },
}));

vi.mock("../lib/useTodayQueryDate", () => ({
  useTodayQueryDate: () => "2026-07-24",
}));

vi.mock("../theme", () => ({
  colors: new Proxy({}, { get: () => "#71717a" }),
  radius: { xl: 16 },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
}));

describe("ReportsScreen", () => {
  beforeEach(() => {
    monthlyQueryControl.showError = false;
    monthlyQueryControl.preserveData = false;
    monthlyQueryControl.showDecisionSupport = true;
    mockWeeklyReportQuery.mockClear();
    mockMonthlyReportQuery.mockClear();
  });

  it("shows weekly and monthly report surfaces with share actions", async () => {
    const { default: ReportsScreen } = await import("./reports");

    render(<ReportsScreen />);

    expect(screen.getByText("Weekly Report")).toBeTruthy();
    expect(screen.getByText("Monthly Report")).toBeTruthy();
    expect(screen.getAllByText("Average Heart Rate Variability (HRV)")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Share weekly report" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share monthly report" })).toBeTruthy();
    expect(screen.getByText("Weekly training increased.")).toBeTruthy();
    expect(screen.getByText("Monthly training increased.")).toBeTruthy();
    expect(mockWeeklyReportQuery).toHaveBeenCalledWith(
      { weeks: 12, endDate: "2026-07-24" },
      { retry: false },
    );
    expect(mockMonthlyReportQuery).toHaveBeenCalledWith({ months: 6 }, { retry: false });
  });

  it("shows the monthly server error instead of the empty state", async () => {
    monthlyQueryControl.showError = true;
    const { default: ReportsScreen } = await import("./reports");

    render(<ReportsScreen />);

    expect(screen.getByText("Monthly report service unavailable")).toBeTruthy();
    expect(screen.queryByText("Not enough monthly data to create a report.")).toBeNull();
  });

  it("renders report metrics without a decision summary when synthesis is unavailable", async () => {
    monthlyQueryControl.showDecisionSupport = false;
    const { default: ReportsScreen } = await import("./reports");

    render(<ReportsScreen />);

    expect(screen.queryByText("Decision summary")).toBeNull();
    expect(screen.getAllByText("Average Heart Rate Variability (HRV)")).toHaveLength(2);
  });

  it("keeps cached monthly report data visible during a background failure", async () => {
    monthlyQueryControl.showError = true;
    monthlyQueryControl.preserveData = true;
    const { default: ReportsScreen } = await import("./reports");

    render(<ReportsScreen />);

    expect(screen.getByRole("button", { name: "Share monthly report" })).toBeTruthy();
    expect(screen.queryByText("Monthly report service unavailable")).toBeNull();
  });
});
