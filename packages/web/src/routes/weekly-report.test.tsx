/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted<{ component: (() => ReactElement) | null }>(() => ({
  component: null,
}));
const mockWeeklyReportQuery = vi.hoisted(() => vi.fn());

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
            },
            isLoading: false,
            error: null,
          };
        },
      },
    },
  },
}));

import "./weekly-report.tsx";

describe("Weekly report route", () => {
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
});
