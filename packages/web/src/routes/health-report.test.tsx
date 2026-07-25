/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockUseSearch = vi.hoisted(() => vi.fn());
const mockGetShared = vi.hoisted(() => vi.fn());
const mockMyReports = vi.hoisted(() => vi.fn());

const captured = vi.hoisted<{
  component: (() => ReactElement) | null;
  validateSearch:
    | ((search: Record<string, unknown>) => { token: string | null | undefined })
    | null;
}>(() => ({
  component: null,
  validateSearch: null,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: {
      component: () => ReactElement;
      validateSearch?: (search: Record<string, unknown>) => {
        token: string | null | undefined;
      };
    }) => {
      captured.component = options.component;
      captured.validateSearch = options.validateSearch ?? null;
      return {};
    },
  useSearch: mockUseSearch,
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

vi.mock("../components/WeeklyReportCard.tsx", () => ({
  WeeklyReportCard: ({ data }: { data?: { current: { weekStart: string } | null } }) => (
    <div>Weekly snapshot {data?.current?.weekStart}</div>
  ),
}));

vi.mock("../components/MonthlyReportContent.tsx", () => ({
  MonthlyReportContent: ({ data }: { data?: { current: { monthStart: string } | null } }) => (
    <div>Monthly snapshot {data?.current?.monthStart}</div>
  ),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    healthReport: {
      getShared: { useQuery: mockGetShared },
      myReports: { useQuery: mockMyReports },
    },
  },
}));

import "./health-report.tsx";

const weeklyReport = {
  id: "report-1",
  shareToken: "shared-token",
  reportType: "weekly",
  reportData: {
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
  expiresAt: null,
  createdAt: "2026-07-24T00:00:00.000Z",
};

function renderRoute(token: string | null | undefined) {
  if (!captured.component) throw new Error("Health report route was not captured");
  mockUseSearch.mockReturnValue({ token });
  const Component = captured.component;
  return render(<Component />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("health report search validation", () => {
  function validate(search: Record<string, unknown>) {
    if (!captured.validateSearch) throw new Error("validateSearch was not captured");
    return captured.validateSearch(search);
  }

  it("distinguishes owner management, malformed links, and valid tokens", () => {
    expect(validate({})).toEqual({ token: undefined });
    expect(validate({ token: "" })).toEqual({ token: null });
    expect(validate({ token: "   " })).toEqual({ token: null });
    expect(validate({ token: " shared-token " })).toEqual({ token: "shared-token" });
    expect(validate({ token: 42 })).toEqual({ token: null });
  });
});

describe("health report route", () => {
  it("renders an anonymous valid shared report without querying the owner list", () => {
    mockGetShared.mockReturnValue({
      data: weeklyReport,
      error: null,
      isLoading: false,
    });

    renderRoute("shared-token");

    expect(mockGetShared).toHaveBeenCalledWith({ token: "shared-token" });
    expect(mockMyReports).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Shared Health Report" })).toBeTruthy();
    expect(screen.getByText("Weekly snapshot 2026-07-19")).toBeTruthy();
  });

  it("renders a valid monthly shared report", () => {
    mockGetShared.mockReturnValue({
      data: {
        ...weeklyReport,
        reportType: "monthly",
        reportData: {
          current: {
            monthStart: "2026-07-01",
            trainingHours: 20,
            activityCount: 10,
            avgDailyStrain: 8,
            avgSleepMinutes: 450,
            avgRestingHr: 55,
            avgHrv: 48,
            trainingHoursTrend: 10,
            avgSleepTrend: -2,
          },
          history: [],
        },
      },
      error: null,
      isLoading: false,
    });

    renderRoute("monthly-token");

    expect(mockGetShared).toHaveBeenCalledWith({ token: "monthly-token" });
    expect(screen.getByText("Monthly snapshot 2026-07-01")).toBeTruthy();
  });

  it("shows a loading state without falling back to owner management", () => {
    mockGetShared.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
    });

    renderRoute("shared-token");

    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    expect(mockMyReports).not.toHaveBeenCalled();
  });

  it("shows a clear invalid-link state for a malformed token", () => {
    renderRoute(null);

    expect(screen.getByText("This shared report link is invalid.")).toBeTruthy();
    expect(mockGetShared).not.toHaveBeenCalled();
    expect(mockMyReports).not.toHaveBeenCalled();
  });

  it("shows a clear missing-or-expired state", () => {
    mockGetShared.mockReturnValue({
      data: null,
      error: null,
      isLoading: false,
    });

    renderRoute("expired-token");

    expect(screen.getByText("This shared report does not exist or has expired.")).toBeTruthy();
    expect(mockMyReports).not.toHaveBeenCalled();
  });

  it("shows the public query error message", () => {
    mockGetShared.mockReturnValue({
      data: undefined,
      error: new Error("Shared report service is unavailable."),
      isLoading: false,
    });

    renderRoute("shared-token");

    expect(screen.getByText("Shared report service is unavailable.")).toBeTruthy();
    expect(mockMyReports).not.toHaveBeenCalled();
  });

  it("rejects malformed persisted report data", () => {
    mockGetShared.mockReturnValue({
      data: {
        ...weeklyReport,
        reportData: { current: { weekStart: "2026-07-19" }, history: [] },
      },
      error: null,
      isLoading: false,
    });

    renderRoute("shared-token");

    expect(screen.getByText("This shared report contains invalid data.")).toBeTruthy();
  });

  it("keeps tokenless owner management on the authenticated query", () => {
    mockMyReports.mockReturnValue({
      data: [],
      error: null,
      isLoading: false,
    });

    renderRoute(undefined);

    expect(mockMyReports).toHaveBeenCalledOnce();
    expect(mockGetShared).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Health Reports" })).toBeTruthy();
    expect(screen.getByText(/No shared reports yet/)).toBeTruthy();
  });
});
