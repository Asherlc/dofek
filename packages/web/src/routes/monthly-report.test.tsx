/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted<{ component: (() => ReactElement) | null }>(() => ({
  component: null,
}));
const queryControl = vi.hoisted(() => ({
  showError: false,
  preserveData: false,
}));
const mockMonthlyReportQuery = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => ReactElement }) => {
    captured.component = options.component;
    return {};
  },
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({
    children,
    headerChildren,
    title,
  }: {
    children: React.ReactNode;
    headerChildren?: React.ReactNode;
    title: string;
  }) => (
    <main>
      <h1>{title}</h1>
      {headerChildren}
      {children}
    </main>
  ),
}));

vi.mock("../components/HealthReportShareButton.tsx", () => ({
  HealthReportShareButton: ({ input }: { input: { reportType: string; months: number } }) => (
    <button type="button">
      Share {input.reportType} report for {input.months} months
    </button>
  ),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    monthlyReport: {
      report: {
        useQuery: (...args: unknown[]) => {
          mockMonthlyReportQuery(...args);
          return {
            data:
              queryControl.showError && !queryControl.preserveData
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
                  },
            isLoading: false,
            error: queryControl.showError ? new Error("Monthly report service unavailable") : null,
          };
        },
      },
    },
  },
}));

import "./monthly-report.tsx";

describe("Monthly report route", () => {
  beforeEach(() => {
    queryControl.showError = false;
    queryControl.preserveData = false;
    mockMonthlyReportQuery.mockClear();
  });

  it("shows canonical monthly data with a share action", () => {
    if (!captured.component) throw new Error("Monthly report route was not captured");
    const MonthlyReportPage = captured.component;

    render(<MonthlyReportPage />);

    expect(screen.getByRole("heading", { name: "Monthly Report" })).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Share monthly report for 6 months",
      }),
    ).toBeTruthy();
    expect(mockMonthlyReportQuery).toHaveBeenCalledWith({ months: 6 }, { retry: false });
  });

  it("shows the server error instead of insufficient data when the query fails", () => {
    queryControl.showError = true;

    if (!captured.component) throw new Error("Monthly report route was not captured");
    const MonthlyReportPage = captured.component;
    render(<MonthlyReportPage />);

    expect(screen.getByText("Monthly report service unavailable")).toBeTruthy();
    expect(screen.queryByText("Not enough data for a monthly report yet.")).toBeNull();
  });

  it("keeps cached report data visible during a background failure", () => {
    queryControl.showError = true;
    queryControl.preserveData = true;

    if (!captured.component) throw new Error("Monthly report route was not captured");
    const MonthlyReportPage = captured.component;
    render(<MonthlyReportPage />);

    expect(
      screen.getByRole("button", {
        name: "Share monthly report for 6 months",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Monthly report service unavailable")).toBeNull();
  });
});
