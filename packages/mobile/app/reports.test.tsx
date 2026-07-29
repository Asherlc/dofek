/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const monthlyQueryControl = vi.hoisted(() => ({
  showError: false,
  preserveData: false,
  weeklyEmpty: false,
  monthlyEmpty: false,
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
            data: monthlyQueryControl.weeklyEmpty
              ? {
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
                    note: "Server weekly no-estimate note.",
                  },
                }
              : {
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
                : monthlyQueryControl.monthlyEmpty
                  ? {
                      current: null,
                      history: [],
                      emptyState: {
                        reportKind: "monthly",
                        title: "Server monthly preview title",
                        message: "Server monthly preview message.",
                        minimumObservedDays: 1,
                        acceptedDataTypes: ["activity", "sleep", "recovery"],
                        requirement: "Server monthly coverage requirement.",
                        previewTitle: "Server monthly structure",
                        previewItems: [
                          "Average daily strain",
                          "Month-over-month training and sleep changes",
                        ],
                        note: "Server monthly no-estimate note.",
                      },
                    }
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
    monthlyQueryControl.weeklyEmpty = false;
    monthlyQueryControl.monthlyEmpty = false;
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

  it("renders the server-owned empty report previews without deriving requirements", async () => {
    monthlyQueryControl.weeklyEmpty = true;
    monthlyQueryControl.monthlyEmpty = true;
    const { default: ReportsScreen } = await import("./reports");

    render(<ReportsScreen />);

    expect(screen.getByText("Server weekly preview title")).toBeTruthy();
    expect(screen.getByText("Server weekly preview message.")).toBeTruthy();
    expect(screen.getByText("Server weekly coverage requirement.")).toBeTruthy();
    expect(screen.getByText("Server weekly structure")).toBeTruthy();
    expect(screen.getByText("Training time and activity count")).toBeTruthy();
    expect(screen.getByText("Server weekly no-estimate note.")).toBeTruthy();
    expect(screen.getByText("Server monthly preview title")).toBeTruthy();
    expect(screen.getByText("Server monthly preview message.")).toBeTruthy();
    expect(screen.getByText("Server monthly coverage requirement.")).toBeTruthy();
    expect(screen.getByText("Server monthly structure")).toBeTruthy();
    expect(screen.getByText("Average daily strain")).toBeTruthy();
    expect(screen.getByText("Server monthly no-estimate note.")).toBeTruthy();
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
