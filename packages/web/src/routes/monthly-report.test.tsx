/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted<{ component: (() => ReactElement) | null }>(() => ({
  component: null,
}));

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

import "./monthly-report.tsx";

describe("Monthly report route", () => {
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
  });
});
