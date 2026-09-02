import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AlertsScreen from "../app/alerts";

const {
  mockAlertsQuery,
  mockDismissAlert,
  mockDismissState,
  mockInvalidateAlerts,
  mockPush,
  mockRefetchAlerts,
  mockRetrySync,
} = vi.hoisted(() => ({
  mockAlertsQuery: vi.fn(),
  mockDismissAlert: vi.fn(),
  mockDismissState: {
    error: null,
    isPending: false,
  } satisfies { error: Error | null; isPending: boolean },
  mockInvalidateAlerts: vi.fn(),
  mockPush: vi.fn(),
  mockRefetchAlerts: vi.fn(),
  mockRetrySync: vi.fn(),
}));

vi.mock("../lib/useProcessingAlerts", () => ({
  useProcessingAlerts: () => mockAlertsQuery(),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    processing: {
      dismiss: {
        useMutation: (options: { onSuccess?: () => Promise<void> | void }) => ({
          error: mockDismissState.error,
          isPending: mockDismissState.isPending,
          mutate: (input: { operationId: string }) => {
            mockDismissAlert(input);
            if (!mockDismissState.error) {
              void options.onSuccess?.();
            }
          },
        }),
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

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

describe("AlertsScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDismissState.error = null;
    mockDismissState.isPending = false;
    mockAlertsQuery.mockReturnValue({
      data: {
        generatedAt: "2026-07-24T12:00:00.000Z",
        alerts: [
          {
            id: "00000000-0000-4000-8000-00000000f501",
            providerId: "wahoo",
            providerLabel: "Wahoo",
            datasetKeys: ["activity", "sleep", "recovery", "training", "body", "providers"],
            datasetLabels: [
              "Activities",
              "Sleep",
              "Recovery",
              "Training",
              "Body",
              "Provider summaries",
            ],
            occurredAt: "2026-07-08T12:00:00.000Z",
            title: "Wahoo sync didn’t finish",
            message:
              "Dofek couldn’t get the latest data from Wahoo. Reconnect Wahoo, then start the sync again.",
            action: "retry_sync",
            actionLabel: "Retry Wahoo sync",
          },
          {
            id: "00000000-0000-4000-8000-00000000f502",
            providerId: "whoop",
            providerLabel: "WHOOP (Cloud)",
            datasetKeys: ["activity"],
            datasetLabels: ["Activities"],
            occurredAt: "2026-07-24T11:58:00.000Z",
            title: "WHOOP (Cloud) sync didn’t finish",
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
    vi.useRealTimers();
  });

  it("renders one grouped alert card with dataset labels and occurrence time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00.000Z"));

    render(<AlertsScreen />);

    expect(screen.getAllByText("Wahoo sync didn’t finish")).toHaveLength(1);
    expect(screen.getAllByText("Activities")).toHaveLength(2);
    expect(screen.getByText("Sleep")).toBeTruthy();
    expect(screen.getByText("Recovery")).toBeTruthy();
    expect(screen.getByText("Training")).toBeTruthy();
    expect(screen.getByText("Body")).toBeTruthy();
    expect(screen.getByText("Provider summaries")).toBeTruthy();
    expect(screen.getByText("Occurred: 16d ago")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry Wahoo sync" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss Wahoo alert" })).toBeTruthy();
  });

  it("shows named active alerts and starts the selected provider sync", () => {
    render(<AlertsScreen />);

    expect(screen.getByText("Wahoo sync didn’t finish")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry Wahoo sync" }));

    expect(mockRetrySync).toHaveBeenCalledWith({ providerId: "wahoo", sinceDays: 7 });
    expect(mockInvalidateAlerts).toHaveBeenCalledOnce();
    expect(screen.getByText("Wahoo sync started.")).toBeTruthy();
  });

  it("takes reconnect alerts to the affected provider", () => {
    render(<AlertsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect WHOOP (Cloud)" }));

    expect(mockPush).toHaveBeenCalledWith("/providers/whoop");
  });

  it("dismisses an alert by operation id and refreshes active alerts", () => {
    render(<AlertsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Wahoo alert" }));

    expect(mockDismissAlert).toHaveBeenCalledWith({
      operationId: "00000000-0000-4000-8000-00000000f501",
    });
    expect(mockInvalidateAlerts).toHaveBeenCalledOnce();
  });

  it("shows the server dismissal error message", () => {
    mockDismissState.error = new Error("Could not dismiss this alert.");

    render(<AlertsScreen />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Could not dismiss this alert.")).toBeTruthy();
  });

  it("disables alert dismiss buttons while dismissal is pending", () => {
    mockDismissState.isPending = true;

    render(<AlertsScreen />);

    expect(
      screen.getByRole("button", { name: "Dismiss Wahoo alert" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("shows a calm empty state when nothing needs attention", () => {
    mockAlertsQuery.mockReturnValue({
      data: { generatedAt: "2026-07-24T12:00:00.000Z", alerts: [] },
      error: null,
      isFetching: false,
      isLoading: false,
      refetch: mockRefetchAlerts,
    });

    render(<AlertsScreen />);

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

    render(<AlertsScreen />);

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

    render(<AlertsScreen />);

    expect(screen.getByText("Alert status is unavailable")).toBeTruthy();
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

    render(<AlertsScreen />);

    expect(screen.getByText("Alert status may be out of date")).toBeTruthy();
    expect(screen.getByText("Wahoo sync didn’t finish")).toBeTruthy();
    expect(screen.getByText(/Showing cached alerts from a previous check/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry alert status" })).toBeTruthy();
  });
});
