import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAbsentBanner } from "./ProviderAbsentBanner";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  pending: false,
  showError: false,
  error: new Error("Provider connection is unavailable"),
  captureException: vi.fn(),
}));

vi.mock("../../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      activity: { invalidate: mocks.invalidate },
      calendar: {
        weekListV2: { invalidate: mocks.invalidate },
        activityOverview: { invalidate: mocks.invalidate },
        calendarData: { invalidate: mocks.invalidate },
      },
    }),
    activity: {
      restoreProviderAbsent: {
        useMutation: (options: {
          onSuccess: () => Promise<void>;
          onError: (error: Error) => void;
        }) => ({
          mutate: (input: { ids: string[] }) => {
            mocks.mutate(input);
            if (mocks.showError) options.onError(mocks.error);
            else void options.onSuccess();
          },
          isPending: mocks.pending,
          error: mocks.showError ? mocks.error : null,
          reset: vi.fn(),
        }),
      },
    },
  },
}));

vi.mock("../../lib/telemetry", () => ({ captureException: mocks.captureException }));

describe("ProviderAbsentBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pending = false;
    mocks.showError = false;
  });
  afterEach(() => cleanup());

  it("restores this activity and refreshes the activity detail, list, and calendar", async () => {
    render(
      <ProviderAbsentBanner
        activity={{
          id: "activity-1",
          providerId: "strava",
          providerAbsentAt: "2026-03-05T14:30:00.000Z",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore activity" }));

    expect(mocks.mutate).toHaveBeenCalledWith({ ids: ["activity-1"] });
    expect(mocks.invalidate).toHaveBeenCalledWith();
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalledTimes(4));
  });

  it("disables the restore action while the request is pending", () => {
    mocks.pending = true;
    render(
      <ProviderAbsentBanner
        activity={{ id: "activity-1", providerId: "strava", providerAbsentAt: null }}
      />,
    );

    expect(screen.getByRole("button", { name: "Restoring…" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("shows the server error and allows retry", () => {
    mocks.showError = true;
    render(
      <ProviderAbsentBanner
        activity={{ id: "activity-1", providerId: "strava", providerAbsentAt: null }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore activity" }));

    expect(screen.getByRole("alert").textContent).toContain("Provider connection is unavailable");
    expect(mocks.captureException).toHaveBeenCalledWith(mocks.error, {
      source: "activity-restore",
    });
  });
});
