import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AlertsScreen from "./alerts";

const { mockAlertsQuery, mockInvalidateAlerts, mockPush, mockRetrySync } = vi.hoisted(() => ({
  mockAlertsQuery: vi.fn(),
  mockInvalidateAlerts: vi.fn(),
  mockPush: vi.fn(),
  mockRetrySync: vi.fn(),
}));

vi.mock("../lib/useProcessingAlerts", () => ({
  useProcessingAlerts: () => mockAlertsQuery(),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
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
            message: "Your previously synced Garmin data is still available.",
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
      isLoading: false,
    });
  });

  it("shows named active alerts and starts the selected provider sync", () => {
    render(<AlertsScreen />);

    expect(screen.getByText("Garmin summary wasn’t updated")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry Garmin sync" }));

    expect(mockRetrySync).toHaveBeenCalledWith({ providerId: "garmin", sinceDays: 7 });
    expect(mockInvalidateAlerts).toHaveBeenCalledOnce();
    expect(screen.getByText("Garmin sync started.")).toBeTruthy();
  });

  it("takes reconnect alerts to the affected provider", () => {
    render(<AlertsScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect WHOOP (Cloud)" }));

    expect(mockPush).toHaveBeenCalledWith("/providers/whoop");
  });

  it("shows a calm empty state when nothing needs attention", () => {
    mockAlertsQuery.mockReturnValue({
      data: { generatedAt: "2026-07-24T12:00:00.000Z", alerts: [] },
      error: null,
      isLoading: false,
    });

    render(<AlertsScreen />);

    expect(screen.getByText("Nothing needs your attention")).toBeTruthy();
  });
});
