/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted<{ component: (() => ReactElement) | null }>(() => ({
  component: null,
}));
const queryControl = vi.hoisted(() => ({
  showEmpty: false,
  showError: false,
  preserveData: false,
}));
const mockMonthlyReportQuery = vi.hoisted(() => vi.fn());
const mockRefetch = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => ReactElement }) => {
    captured.component = options.component;
    return {};
  },
  useNavigate: () => mockNavigate,
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
                    current: queryControl.showEmpty
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
                  },
            isLoading: false,
            isFetching: false,
            error: queryControl.showError ? new Error("Monthly report service unavailable") : null,
            refetch: mockRefetch,
          };
        },
      },
    },
  },
}));

vi.mock("../hooks/useTodayQueryDate.ts", () => ({
  useTodayQueryDate: () => "2026-07-24",
}));

import "./monthly-report.tsx";

describe("Monthly report route", () => {
  beforeEach(() => {
    queryControl.showEmpty = false;
    queryControl.showError = false;
    queryControl.preserveData = false;
    mockMonthlyReportQuery.mockClear();
    mockRefetch.mockClear();
    mockNavigate.mockClear();
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
    expect(mockMonthlyReportQuery).toHaveBeenCalledWith(
      { months: 6, endDate: "2026-07-24" },
      { retry: false },
    );
  });

  it("shows the server error instead of insufficient data when the query fails", () => {
    queryControl.showError = true;

    if (!captured.component) throw new Error("Monthly report route was not captured");
    const MonthlyReportPage = captured.component;
    render(<MonthlyReportPage />);

    expect(screen.getByText("Monthly report service unavailable")).toBeTruthy();
    expect(screen.queryByText("Not enough data for a monthly report yet.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry report" }));
    fireEvent.click(screen.getByRole("button", { name: "Review data alerts" }));
    expect(mockRefetch).toHaveBeenCalledOnce();
    expect(mockNavigate).toHaveBeenCalledWith({ to: "/alerts" });
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
    expect(screen.getByText("Monthly report service unavailable")).toBeTruthy();
    expect(screen.getByText("Showing the last available report")).toBeTruthy();
  });

  it("shows the server-authored range and prerequisites when no report data exists", () => {
    queryControl.showEmpty = true;

    if (!captured.component) throw new Error("Monthly report route was not captured");
    const MonthlyReportPage = captured.component;
    render(<MonthlyReportPage />);

    expect(
      screen.getByText(
        "No activity, sleep, or recovery data was found from 2026-02-01 through 2026-07-24. Sync your providers, then retry or review processing alerts.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review data alerts" })).toBeTruthy();
  });
});
