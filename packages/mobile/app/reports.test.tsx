/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../components/HealthReportShareButton", () => ({
  HealthReportShareButton: ({ input }: { input: { reportType: string } }) => (
    <button type="button">Share {input.reportType} report</button>
  ),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    weeklyReport: {
      report: {
        useQuery: () => ({
          data: {
            current: {
              weekStart: "2026-07-19",
              trainingHours: 5,
              activityCount: 3,
              strainZone: "optimal",
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
        }),
      },
    },
    monthlyReport: {
      report: {
        useQuery: () => ({
          data: {
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
          error: null,
        }),
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
  it("shows weekly and monthly report surfaces with share actions", async () => {
    const { default: ReportsScreen } = await import("./reports");

    render(<ReportsScreen />);

    expect(screen.getByText("Weekly Report")).toBeTruthy();
    expect(screen.getByText("Monthly Report")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share weekly report" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share monthly report" })).toBeTruthy();
  });
});
