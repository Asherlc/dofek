/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUseSearch = vi.hoisted(() => vi.fn());
const mockGetShared = vi.hoisted(() => vi.fn());
const mockMyReports = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const mockWriteText = vi.hoisted(() => vi.fn());

const captured = vi.hoisted<{
  component: (() => ReactElement) | null;
  validateSearch: ((search: Record<string, unknown>) => { token?: string | null }) | null;
  weeklyReportData: { emptyState?: { reportKind: string } } | undefined;
  monthlyReportData: { emptyState?: { reportKind: string } } | undefined;
}>(() => ({
  component: null,
  validateSearch: null,
  weeklyReportData: undefined,
  monthlyReportData: undefined,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute:
    () =>
    (options: {
      component: () => ReactElement;
      validateSearch?: (search: Record<string, unknown>) => { token?: string | null };
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
  WeeklyReportCard: ({
    data,
  }: {
    data?: {
      current: { weekStart: string } | null;
      decisionSupport?: { whatChanged: string[] } | null;
      emptyState?: { reportKind: string; title: string };
    };
  }) => {
    captured.weeklyReportData = data;
    return (
      <div>
        {data?.current
          ? `Weekly snapshot ${data.current.weekStart} ${data.decisionSupport?.whatChanged[0] ?? ""}${data.emptyState ? ` empty:${data.emptyState.reportKind}` : ""}`
          : `Weekly empty ${data?.emptyState?.title ?? "missing"}`}
      </div>
    );
  },
}));

vi.mock("../components/MonthlyReportContent.tsx", () => ({
  MonthlyReportContent: ({
    data,
  }: {
    data?: {
      current: { monthStart: string } | null;
      emptyState?: { reportKind: string; title: string };
    };
  }) => {
    captured.monthlyReportData = data;
    return (
      <div>
        {data?.current
          ? `Monthly snapshot ${data.current.monthStart}${data.emptyState ? ` empty:${data.emptyState.reportKind}` : ""}`
          : `Monthly empty ${data?.emptyState?.title ?? "missing"}`}
      </div>
    );
  },
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    healthReport: {
      getShared: { useQuery: mockGetShared },
      myReports: { useQuery: mockMyReports },
    },
  },
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mockCaptureException,
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
      avgDailyLoad: 4,
      avgSleepMinutes: 450,
      sleepPerformancePct: 100,
      avgReadiness: 0,
      avgRestingHr: 55,
      avgHrv: 48,
    },
    history: [],
    decisionSupport: null,
    emptyState: {
      reportKind: "weekly" as const,
      title: "Your weekly report will appear here",
      message: "No activity, sleep, or recovery data is available for this report yet.",
      minimumObservedDays: 1,
      acceptedDataTypes: ["activity", "sleep", "recovery"] as const,
      requirement:
        "At least 1 observed day of activity, sleep, or recovery data is required to create a weekly report.",
      previewTitle: "When ready, your weekly report will include",
      previewItems: ["Training time and activity count", "Average nightly sleep"],
      note: "This preview shows report sections only. No personal values or conclusions are estimated.",
    },
    recovery: {
      range: { startDate: "2026-07-19", endDate: "2026-07-25" },
      emptyMessage: "No data found for this period.",
    },
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

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mockWriteText },
  });
  mockWriteText.mockResolvedValue(undefined);
  captured.weeklyReportData = undefined;
  captured.monthlyReportData = undefined;
});

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
    expect(validate({})).toStrictEqual({});
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
    expect(screen.getByText(/Weekly snapshot 2026-07-19/)).toBeTruthy();
    expect(screen.getByText(/empty:weekly/)).toBeTruthy();
    expect(captured.weeklyReportData?.emptyState?.reportKind).toBe("weekly");
  });

  it("renders decision support stored in a new shared report snapshot", () => {
    mockGetShared.mockReturnValue({
      data: {
        ...weeklyReport,
        reportData: {
          ...weeklyReport.reportData,
          decisionSupport: {
            whatChanged: ["Weekly training increased."],
            likelyAssociations: ["Training and sleep moved together."],
            whatWorked: ["Sleep stayed consistent."],
            whatToTryNext: ["Repeat the routine next week."],
            confidenceAndMissingData: ["Confidence is limited."],
          },
        },
      },
      error: null,
      isLoading: false,
    });

    renderRoute("new-shared-token");

    expect(screen.getByText(/Weekly training increased/)).toBeTruthy();
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
          decisionSupport: null,
          emptyState: {
            reportKind: "monthly" as const,
            title: "Your monthly report will appear here",
            message: "No activity, sleep, or recovery data is available for this report yet.",
            minimumObservedDays: 1,
            acceptedDataTypes: ["activity", "sleep", "recovery"] as const,
            requirement:
              "At least 1 observed day of activity, sleep, or recovery data is required to create a monthly report.",
            previewTitle: "When ready, your monthly report will include",
            previewItems: ["Training time and activity count", "Average daily strain"],
            note: "This preview shows report sections only. No personal values or conclusions are estimated.",
          },
          recovery: {
            range: { startDate: "2026-07-01", endDate: "2026-07-31" },
            emptyMessage: "No data found for this period.",
          },
        },
      },
      error: null,
      isLoading: false,
    });

    renderRoute("monthly-token");

    expect(mockGetShared).toHaveBeenCalledWith({ token: "monthly-token" });
    expect(screen.getByText(/Monthly snapshot 2026-07-01/)).toBeTruthy();
    expect(screen.getByText(/empty:monthly/)).toBeTruthy();
    expect(captured.monthlyReportData?.emptyState?.reportKind).toBe("monthly");
  });

  it("renders legacy weekly shared reports that omit emptyState and recovery metadata", () => {
    mockGetShared.mockReturnValue({
      data: {
        ...weeklyReport,
        reportData: {
          current: weeklyReport.reportData.current,
          history: weeklyReport.reportData.history,
          decisionSupport: weeklyReport.reportData.decisionSupport,
        },
      },
      error: null,
      isLoading: false,
    });

    renderRoute("legacy-weekly-token");

    expect(screen.getByText(/Weekly snapshot 2026-07-19/)).toBeTruthy();
    expect(screen.getByText(/empty:weekly/)).toBeTruthy();
    expect(captured.weeklyReportData?.emptyState?.reportKind).toBe("weekly");
  });

  it("renders legacy monthly shared reports that omit emptyState and recovery metadata", () => {
    const monthlyCurrent = {
      monthStart: "2026-07-01",
      trainingHours: 20,
      activityCount: 10,
      avgDailyStrain: 8,
      avgSleepMinutes: 450,
      avgRestingHr: 55,
      avgHrv: 48,
      trainingHoursTrend: 10,
      avgSleepTrend: -2,
    };

    mockGetShared.mockReturnValue({
      data: {
        ...weeklyReport,
        reportType: "monthly",
        reportData: {
          current: monthlyCurrent,
          history: [],
          decisionSupport: null,
        },
      },
      error: null,
      isLoading: false,
    });

    renderRoute("legacy-monthly-token");

    expect(mockGetShared).toHaveBeenCalledWith({ token: "legacy-monthly-token" });
    expect(screen.getByText(/Monthly snapshot 2026-07-01/)).toBeTruthy();
    expect(screen.getByText(/empty:monthly/)).toBeTruthy();
    expect(captured.monthlyReportData?.emptyState?.reportKind).toBe("monthly");
  });

  it("renders an empty weekly shared report from stored server empty state", () => {
    mockGetShared.mockReturnValue({
      data: {
        ...weeklyReport,
        reportData: {
          ...weeklyReport.reportData,
          current: null,
          emptyState: {
            reportKind: "weekly" as const,
            title: "Server weekly preview title",
            message: "Server weekly preview message.",
            minimumObservedDays: 1,
            acceptedDataTypes: ["activity", "sleep", "recovery"] as const,
            requirement: "Server weekly coverage requirement.",
            previewTitle: "Server weekly structure",
            previewItems: ["Training time and activity count", "Average nightly sleep"],
            note: "Server no-estimate note.",
          },
        },
      },
      error: null,
      isLoading: false,
    });

    renderRoute("empty-weekly-token");

    expect(screen.getByText("Weekly empty Server weekly preview title")).toBeTruthy();
  });

  it("renders an empty monthly shared report from stored server empty state", () => {
    mockGetShared.mockReturnValue({
      data: {
        ...weeklyReport,
        reportType: "monthly",
        reportData: {
          current: null,
          history: [],
          decisionSupport: null,
          emptyState: {
            reportKind: "monthly" as const,
            title: "Server monthly preview title",
            message: "Server monthly preview message.",
            minimumObservedDays: 1,
            acceptedDataTypes: ["activity", "sleep", "recovery"] as const,
            requirement: "Server monthly coverage requirement.",
            previewTitle: "Server monthly structure",
            previewItems: ["Average daily strain", "Month-over-month training and sleep changes"],
            note: "Server no-estimate note.",
          },
          recovery: {
            range: { startDate: "2026-07-01", endDate: "2026-07-31" },
            emptyMessage: "No data found for this period.",
          },
        },
      },
      error: null,
      isLoading: false,
    });

    renderRoute("empty-monthly-token");

    expect(screen.getByText("Monthly empty Server monthly preview title")).toBeTruthy();
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

  it.each(["weekly", "monthly"] as const)("rejects an empty %s persisted report", (reportType) => {
    mockGetShared.mockReturnValue({
      data: {
        ...weeklyReport,
        reportType,
        reportData: { current: null, history: [] },
      },
      error: null,
      isLoading: false,
    });

    renderRoute("shared-token");

    expect(screen.getByText("This shared report contains invalid data.")).toBeTruthy();
  });

  it("rejects blank decision-support narratives in persisted report data", () => {
    mockGetShared.mockReturnValue({
      data: {
        ...weeklyReport,
        reportData: {
          ...weeklyReport.reportData,
          decisionSupport: {
            whatChanged: ["   "],
            likelyAssociations: [],
            whatWorked: [],
            whatToTryNext: [],
            confidenceAndMissingData: [],
          },
        },
      },
      error: null,
      isLoading: false,
    });

    renderRoute("shared-token");

    expect(screen.getByText("This shared report contains invalid data.")).toBeTruthy();
  });

  it("keeps owner management without a token on the authenticated query", () => {
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

  it("shows the owner list error instead of the empty state", () => {
    mockMyReports.mockReturnValue({
      data: undefined,
      error: new Error("Health report list is unavailable."),
      isLoading: false,
    });

    renderRoute(undefined);

    expect(screen.getByText("Health report list is unavailable.")).toBeTruthy();
    expect(screen.queryByText(/No shared reports yet/)).toBeNull();
  });

  it("paginates shared reports", () => {
    mockMyReports.mockReturnValue({
      data: Array.from({ length: 21 }, (_, index) => ({
        ...weeklyReport,
        id: `report-${index + 1}`,
        shareToken: `token-${index + 1}`,
      })),
      error: null,
      isLoading: false,
    });

    renderRoute(undefined);

    expect(screen.getAllByRole("button", { name: "Copy Link" })).toHaveLength(20);

    fireEvent.click(screen.getByRole("button", { name: "Next reports page" }));

    expect(screen.getAllByRole("button", { name: "Copy Link" })).toHaveLength(1);
  });

  it("shows copied only after the clipboard write succeeds", async () => {
    let completeWrite = () => {};
    mockWriteText.mockReturnValue(
      new Promise<void>((resolve) => {
        completeWrite = resolve;
      }),
    );
    mockMyReports.mockReturnValue({
      data: [weeklyReport],
      error: null,
      isLoading: false,
    });

    renderRoute(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Copy Link" }));

    expect(screen.getByRole("button", { name: "Copy Link" })).toBeTruthy();
    completeWrite();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    });
    expect(mockWriteText).toHaveBeenCalledWith(
      `${window.location.origin}/health-report?token=shared-token`,
    );
  });

  it("reports clipboard rejection and provides a manual-copy fallback", async () => {
    const clipboardError = new Error("Clipboard permission denied");
    mockWriteText.mockRejectedValue(clipboardError);
    mockMyReports.mockReturnValue({
      data: [weeklyReport],
      error: null,
      isLoading: false,
    });

    renderRoute(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Copy Link" }));

    await waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(clipboardError, {
        source: "health-report-list-link-copy",
      });
    });
    expect(screen.getByRole("button", { name: "Copy Link" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Copy report link manually" })).toHaveValue(
      `${window.location.origin}/health-report?token=shared-token`,
    );
  });
});
