/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted<{ component: (() => ReactElement) | null }>(() => ({
  component: null,
}));
const mockWeeklyReportQuery = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockRefetch = vi.hoisted(() => vi.fn());
const queryControl = vi.hoisted(() => ({
  preserveData: false,
  showEmpty: false,
  showError: false,
}));

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

vi.mock("../components/WeeklyReportCard.tsx", () => ({
  WeeklyReportCard: () => <div>Weekly report data</div>,
}));

vi.mock("../components/HealthReportShareButton.tsx", () => ({
  HealthReportShareButton: ({ input }: { input: { reportType: string; endDate: string } }) => (
    <button type="button">
      Share {input.reportType} report ending {input.endDate}
    </button>
  ),
}));

vi.mock("../hooks/useTodayQueryDate.ts", () => ({
  useTodayQueryDate: () => "2026-07-24",
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    weeklyReport: {
      report: {
        useQuery: (...args: unknown[]) => {
          mockWeeklyReportQuery(...args);
          return {
            data:
              queryControl.showError && !queryControl.preserveData
                ? undefined
                : {
                    current: queryControl.showEmpty
                      ? null
                      : {
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
                    recovery: {
                      range: { startDate: "2026-05-03", endDate: "2026-07-24" },
                      emptyMessage:
                        "No activity, sleep, or recovery data was found from 2026-05-03 through 2026-07-24. Sync your providers, then retry or review processing alerts.",
                    },
                  },
            isLoading: false,
            isFetching: false,
            error: queryControl.showError ? new Error("Weekly report service unavailable") : null,
            refetch: mockRefetch,
          };
        },
      },
    },
  },
}));

import "./weekly-report.tsx";

describe("Weekly report route", () => {
  beforeEach(() => {
    queryControl.preserveData = false;
    queryControl.showEmpty = false;
    queryControl.showError = false;
    mockNavigate.mockClear();
    mockRefetch.mockClear();
    mockWeeklyReportQuery.mockClear();
  });

  it("shows canonical weekly data with a share action", () => {
    if (!captured.component) throw new Error("Weekly report route was not captured");
    const WeeklyReportPage = captured.component;

    render(<WeeklyReportPage />);

    expect(screen.getByRole("heading", { name: "Weekly Report" })).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Share weekly report ending 2026-07-24",
      }),
    ).toBeTruthy();
    expect(mockWeeklyReportQuery).toHaveBeenCalledWith(
      { weeks: 12, endDate: "2026-07-24" },
      { retry: false },
    );
  });

  it("offers retry and data review for a blocking weekly failure", () => {
    queryControl.showError = true;
    if (!captured.component) throw new Error("Weekly report route was not captured");
    const WeeklyReportPage = captured.component;

    render(<WeeklyReportPage />);

    expect(screen.getByText("Weekly report service unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry report" }));
    fireEvent.click(screen.getByRole("button", { name: "Review data alerts" }));
    expect(mockRefetch).toHaveBeenCalledOnce();
    expect(mockNavigate).toHaveBeenCalledWith({ to: "/alerts" });
  });

  it("keeps cached weekly data visible and warns when refresh fails", () => {
    queryControl.showError = true;
    queryControl.preserveData = true;
    if (!captured.component) throw new Error("Weekly report route was not captured");
    const WeeklyReportPage = captured.component;

    render(<WeeklyReportPage />);

    expect(screen.getByText("Weekly report data")).toBeTruthy();
    expect(screen.getByText("Showing the last available report")).toBeTruthy();
    expect(screen.getByText("Weekly report service unavailable")).toBeTruthy();
  });

  it("uses the server-authored weekly range and prerequisites when data is empty", () => {
    queryControl.showEmpty = true;
    if (!captured.component) throw new Error("Weekly report route was not captured");
    const WeeklyReportPage = captured.component;

    render(<WeeklyReportPage />);

    expect(
      screen.getByText(
        "No activity, sleep, or recovery data was found from 2026-05-03 through 2026-07-24. Sync your providers, then retry or review processing alerts.",
      ),
    ).toBeTruthy();
  });
});
