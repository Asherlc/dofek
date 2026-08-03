/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertsPage } from "./AlertsPage.tsx";

const { mockAlertsQuery, mockInvalidateAlerts, mockRefetchAlerts, mockRetrySync } = vi.hoisted(
  () => ({
    mockAlertsQuery: vi.fn(),
    mockInvalidateAlerts: vi.fn(),
    mockRefetchAlerts: vi.fn(),
    mockRetrySync: vi.fn(),
  }),
);

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    processing: {
      alerts: {
        useQuery: () => mockAlertsQuery(),
      },
    },
    sync: {
      triggerSync: {
        useMutation: (options: { onSuccess: (data: undefined, input: unknown) => void }) => ({
          error: null,
          isPending: false,
          mutate: (input: unknown) => {
            mockRetrySync(input);
            options.onSuccess(undefined, input);
          },
        }),
      },
    },
    useUtils: () => ({
      processing: { alerts: { invalidate: mockInvalidateAlerts } },
    }),
  },
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children, title }: { children: ReactNode; title: string }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

describe("AlertsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAlertsQuery.mockReturnValue({
      data: {
        generatedAt: "2026-07-24T12:00:00.000Z",
        alerts: [
          {
            id: "operation-1:providers",
            providerId: "garmin",
            providerLabel: "Garmin",
            datasetKey: "providers",
            occurredAt: "2026-07-24T11:59:00.000Z",
            title: "Garmin summary wasn’t updated",
            message:
              "Your Garmin data synced, but its totals couldn’t be refreshed. Your previously synced data is still available.",
            action: "retry_sync",
            actionLabel: "Retry Garmin sync",
          },
          {
            id: "operation-2:activity",
            providerId: "whoop",
            providerLabel: "WHOOP (Cloud)",
            datasetKey: "activity",
            occurredAt: "2026-07-24T11:58:00.000Z",
            title: "WHOOP (Cloud) couldn’t sync",
            message: "Reconnect WHOOP (Cloud), then start the sync again.",
            action: "reconnect",
            actionLabel: "Reconnect WHOOP (Cloud)",
          },
        ],
      },
      error: null,
      isFetching: false,
      isLoading: false,
      refetch: mockRefetchAlerts,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names each affected source and presents its server-selected action", () => {
    render(<AlertsPage />);

    expect(screen.getByText("Garmin summary wasn’t updated")).toBeTruthy();
    expect(screen.getByText("WHOOP (Cloud) couldn’t sync")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry Garmin sync" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Reconnect WHOOP (Cloud)" }).getAttribute("href")).toBe(
      "/providers/$id",
    );
  });

  it("starts the named provider sync and refreshes active alerts", () => {
    render(<AlertsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Retry Garmin sync" }));

    expect(mockRetrySync).toHaveBeenCalledWith({ providerId: "garmin", sinceDays: 7 });
    expect(mockInvalidateAlerts).toHaveBeenCalledOnce();
    expect(screen.getByText("Garmin sync started.")).toBeTruthy();
  });

  it("shows a calm empty state when nothing needs attention", () => {
    mockAlertsQuery.mockReturnValue({
      data: { generatedAt: "2026-07-24T12:00:00.000Z", alerts: [] },
      error: null,
      isFetching: false,
      isLoading: false,
      refetch: mockRefetchAlerts,
    });

    render(<AlertsPage />);

    expect(screen.getByText("Nothing needs your attention")).toBeTruthy();
    expect(screen.getByText("When an alert appears, it will show")).toBeTruthy();
    expect(screen.getByText("What happened")).toBeTruthy();
    expect(screen.getByText("When it happened")).toBeTruthy();
    expect(screen.getByText("What to do next")).toBeTruthy();
    expect(
      screen.getByText("Only real problems detected for your account are shown."),
    ).toBeTruthy();
  });

  it("paginates active alerts", () => {
    const baseAlert = mockAlertsQuery().data.alerts[0];
    mockAlertsQuery.mockReturnValue({
      data: {
        generatedAt: "2026-07-24T12:00:00.000Z",
        alerts: Array.from({ length: 21 }, (_, index) => ({
          ...baseAlert,
          id: `alert-${index + 1}`,
          title: `Alert ${index + 1}`,
        })),
      },
      error: null,
      isFetching: false,
      isLoading: false,
      refetch: mockRefetchAlerts,
    });

    render(<AlertsPage />);

    expect(screen.getByText("Alert 1")).toBeTruthy();
    expect(screen.queryByText("Alert 21")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next alerts page" }));

    expect(screen.queryByText("Alert 1")).toBeNull();
    expect(screen.getByText("Alert 21")).toBeTruthy();
  });

  it("explains an unavailable alert-status check and offers one retry", () => {
    mockAlertsQuery.mockReturnValue({
      data: undefined,
      error: new Error("Status service timed out."),
      isFetching: false,
      isLoading: false,
      refetch: mockRefetchAlerts,
    });

    render(<AlertsPage />);

    expect(screen.getByRole("heading", { name: "Alert status is unavailable" })).toBeTruthy();
    expect(screen.getByText(/Your synced health data is still available/)).toBeTruthy();
    expect(screen.getByText(/this status check did not pause syncs or imports/)).toBeTruthy();
    expect(screen.getByText(/Details: Status service timed out\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry alert status" }));

    expect(mockRefetchAlerts).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("button", { name: "Retry alert status" })).toHaveLength(1);
  });

  it("keeps cached alerts visible when their check timestamp is invalid", () => {
    const currentQuery = mockAlertsQuery();
    mockAlertsQuery.mockReturnValue({
      ...currentQuery,
      data: {
        ...currentQuery.data,
        generatedAt: "invalid-timestamp",
      },
      error: new Error("Status service timed out."),
    });

    render(<AlertsPage />);

    expect(screen.getByRole("heading", { name: "Alert status may be out of date" })).toBeTruthy();
    expect(screen.getByText("Garmin summary wasn’t updated")).toBeTruthy();
    expect(screen.getByText(/Showing cached alerts from a previous check/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry alert status" })).toBeTruthy();
  });
});
