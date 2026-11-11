import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAbsentBanner } from "./ProviderAbsentBanner";

const mocks = vi.hoisted(() => {
  const state: {
    restoreData: {
      analyticsJobId: string | null;
      restoredCount: number;
      analyticsError: string | null;
    } | null;
    refreshStatus: { status: "pending" | "completed" | "failed"; error: string | null } | null;
  } = { restoreData: null, refreshStatus: null };
  return {
    ...state,
    mutate: vi.fn(),
    invalidate: vi.fn(),
    pending: false,
    showError: false,
    error: new Error("Provider connection is unavailable"),
    captureException: vi.fn(),
    statusQuery: vi.fn(),
  };
});

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
      restoreStatus: {
        useQuery: (...args: unknown[]) => {
          mocks.statusQuery(...args);
          return { data: mocks.refreshStatus, error: null };
        },
      },
      restoreProviderAbsent: {
        useMutation: (options: {
          onSuccess: (result: {
            analyticsJobId: string | null;
            restoredCount: number;
            analyticsError: string | null;
          }) => Promise<void>;
          onError: (error: Error) => void;
        }) => ({
          mutate: (input: { ids: string[] }) => {
            mocks.mutate(input);
            if (mocks.showError) options.onError(mocks.error);
            else
              void options.onSuccess(
                mocks.restoreData ?? {
                  analyticsJobId: null,
                  restoredCount: 0,
                  analyticsError: null,
                },
              );
          },
          data: mocks.restoreData,
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
    mocks.restoreData = null;
    mocks.refreshStatus = null;
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

  it("refreshes mounted queries again after analytics completes, even if the activity already became visible", async () => {
    const activity = {
      id: "activity-1",
      providerId: "strava",
      providerAbsentAt: "2026-03-05T14:30:00.000Z",
    };
    const { rerender } = render(<ProviderAbsentBanner activity={activity} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore activity" }));
    expect(mocks.invalidate).toHaveBeenCalledTimes(4);

    mocks.restoreData = { analyticsJobId: "restore-job-1", restoredCount: 1, analyticsError: null };
    mocks.refreshStatus = { status: "pending", error: null };
    rerender(<ProviderAbsentBanner activity={{ ...activity, providerAbsentAt: null }} />);
    expect(mocks.statusQuery).toHaveBeenLastCalledWith(
      { jobId: "restore-job-1" },
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByRole("status").textContent).toContain("Refreshing restored activity charts");
    expect(mocks.invalidate).toHaveBeenCalledTimes(4);

    mocks.refreshStatus = { status: "completed", error: null };
    rerender(<ProviderAbsentBanner activity={{ ...activity, providerAbsentAt: null }} />);
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalledTimes(8));
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<ProviderAbsentBanner activity={{ ...activity, providerAbsentAt: null }} />);
    expect(mocks.invalidate).toHaveBeenCalledTimes(8);
  });

  it("stops polling after completion, failure, or an unavailable status with retained pending data", () => {
    render(
      <ProviderAbsentBanner
        activity={{
          id: "activity-1",
          providerId: "strava",
          subsource: null,
          providerAbsentAt: "2026-03-05T14:30:00.000Z",
        }}
      />,
    );
    const options = mocks.statusQuery.mock.lastCall?.[1];
    if (
      !options ||
      typeof options !== "object" ||
      !("refetchInterval" in options) ||
      typeof options.refetchInterval !== "function"
    )
      throw new Error("Status query must supply a polling interval");
    const interval = options.refetchInterval;
    expect(interval({ state: { data: { status: "pending" }, error: null } })).toBe(2_000);
    expect(interval({ state: { data: { status: "completed" }, error: null } })).toBe(false);
    expect(interval({ state: { data: { status: "failed" }, error: null } })).toBe(false);
    expect(
      interval({
        state: { data: { status: "pending" }, error: new Error("Restore status unavailable") },
      }),
    ).toBe(false);
  });

  it("keeps an actionable analytics failure visible after restoration", () => {
    mocks.restoreData = { analyticsJobId: "restore-job-1", restoredCount: 1, analyticsError: null };
    mocks.refreshStatus = {
      status: "failed",
      error: "Activity restored, but refreshing charts failed. Use Recompute to retry.",
    };
    render(
      <ProviderAbsentBanner
        activity={{ id: "activity-1", providerId: "strava", providerAbsentAt: null }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Use Recompute to retry");
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("disables the restore action while the request is pending", () => {
    mocks.pending = true;
    render(
      <ProviderAbsentBanner
        activity={{
          id: "activity-1",
          providerId: "strava",
          providerAbsentAt: "2026-03-05T14:30:00.000Z",
        }}
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
        activity={{
          id: "activity-1",
          providerId: "strava",
          providerAbsentAt: "2026-03-05T14:30:00.000Z",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore activity" }));

    expect(screen.getByRole("alert").textContent).toContain("Provider connection is unavailable");
    expect(mocks.captureException).toHaveBeenCalledWith(mocks.error, {
      source: "activity-restore",
    });
  });
});
