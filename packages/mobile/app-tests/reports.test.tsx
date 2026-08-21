/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const monthlyQueryControl = vi.hoisted(() => ({
  showEmpty: false,
  showError: false,
  preserveData: false,
  weeklyEmpty: false,
  monthlyEmpty: false,
  showDecisionSupport: true,
}));
const mockWeeklyReportQuery = vi.hoisted(() => vi.fn());
const mockMonthlyReportQuery = vi.hoisted(() => vi.fn());
const mockMonthlyRefetch = vi.hoisted(() => vi.fn());
const mockHealthReportShare = vi.hoisted(() => vi.fn());
const mockPush = vi.hoisted(() => vi.fn());

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("../components/HealthReportShareButton", () => ({
  HealthReportShareButton: ({ input }: { input: { reportType: string } }) => {
    mockHealthReportShare(input);
    return <button type="button">Share {input.reportType} report</button>;
  },
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
                  decisionSupport: null,
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
                      decisionSupport: null,
                    }
                  : {
                      current: monthlyQueryControl.showEmpty
                        ? null
                        : {
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
                      recovery: {
                        range: { startDate: "2026-02-01", endDate: "2026-07-24" },
                        emptyMessage:
                          "No activity, sleep, or recovery data was found from 2026-02-01 through 2026-07-24. Sync your providers, then retry or review processing alerts.",
                      },
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
            isFetching: false,
            error: monthlyQueryControl.showError
              ? new Error("Monthly report service unavailable")
              : null,
            refetch: mockMonthlyRefetch,
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
    monthlyQueryControl.showEmpty = false;
    monthlyQueryControl.showError = false;
    monthlyQueryControl.preserveData = false;
    monthlyQueryControl.weeklyEmpty = false;
    monthlyQueryControl.monthlyEmpty = false;
    monthlyQueryControl.showDecisionSupport = true;
    mockWeeklyReportQuery.mockClear();
    mockMonthlyReportQuery.mockClear();
    mockMonthlyRefetch.mockClear();
    mockHealthReportShare.mockClear();
    mockPush.mockClear();
  });

  it("shows weekly and monthly report surfaces with share actions", async () => {
    const { default: ReportsScreen } = await import("../app/reports");

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
    expect(mockMonthlyReportQuery).toHaveBeenCalledWith(
      { months: 6, endDate: "2026-07-24" },
      { retry: false },
    );
    expect(mockHealthReportShare).toHaveBeenCalledWith({
      reportType: "monthly",
      months: 6,
      endDate: "2026-07-24",
    });
  });

  it("shows the monthly server error instead of the empty state", async () => {
    monthlyQueryControl.showError = true;
    const { default: ReportsScreen } = await import("../app/reports");

    render(<ReportsScreen />);

    expect(screen.getByText("Monthly report service unavailable")).toBeTruthy();
    expect(screen.queryByText("Not enough monthly data to create a report.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry report" }));
    fireEvent.click(screen.getByRole("button", { name: "Review data alerts" }));
    expect(mockMonthlyRefetch).toHaveBeenCalledOnce();
    expect(mockPush).toHaveBeenCalledWith("/alerts");
  });

  it("renders the server-owned empty report previews without deriving requirements", async () => {
    monthlyQueryControl.weeklyEmpty = true;
    monthlyQueryControl.monthlyEmpty = true;
    const { default: ReportsScreen } = await import("../app/reports");

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

  it("renders report metrics without a decision summary when synthesis is unavailable", async () => {
    monthlyQueryControl.showDecisionSupport = false;
    const { default: ReportsScreen } = await import("../app/reports");

    render(<ReportsScreen />);

    expect(screen.queryByText("Decision summary")).toBeNull();
    expect(screen.getAllByText("Average Heart Rate Variability (HRV)")).toHaveLength(2);
  });

  it("keeps cached monthly report data visible during a background failure", async () => {
    monthlyQueryControl.showError = true;
    monthlyQueryControl.preserveData = true;
    const { default: ReportsScreen } = await import("../app/reports");

    render(<ReportsScreen />);

    expect(screen.getByRole("button", { name: "Share monthly report" })).toBeTruthy();
    expect(screen.getByText("Monthly report service unavailable")).toBeTruthy();
    expect(screen.getByText("Showing the last available report")).toBeTruthy();
  });

  it("shows the server-authored range and prerequisites when no monthly data exists", async () => {
    monthlyQueryControl.showEmpty = true;
    const { default: ReportsScreen } = await import("../app/reports");

    render(<ReportsScreen />);

    expect(
      screen.getByText(
        "No activity, sleep, or recovery data was found from 2026-02-01 through 2026-07-24. Sync your providers, then retry or review processing alerts.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review data alerts" })).toBeTruthy();
  });
});
