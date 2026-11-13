/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecomputeActivityButton } from "./RecomputeActivityButton.tsx";

type RecomputeStatus = { status: "pending" | "completed" | "failed"; error: string | null };

const mocks = vi.hoisted(() => {
  const state: {
    mutationResult: { success: boolean; analyticsJobId: string | null };
    mutationError: Error | null;
    status: RecomputeStatus | undefined;
    statusError: Error | null;
  } = {
    mutationResult: { success: true, analyticsJobId: "recompute-job-1" },
    mutationError: null,
    status: undefined,
    statusError: null,
  };
  return {
    ...state,
    mutate: vi.fn(),
    statusQuery: vi.fn(),
    resetStatus: vi.fn(),
    invalidate: {
      byId: vi.fn(),
      stream: vi.fn(),
      heartRateContext: vi.fn(),
      hrZones: vi.fn(),
      powerZones: vi.fn(),
      powerWork: vi.fn(),
      strengthExercises: vi.fn(),
      list: vi.fn(),
      weekListV2: vi.fn(),
      activityOverview: vi.fn(),
    },
    captureException: vi.fn(),
  };
});

vi.mock("../../../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      activity: {
        byId: { invalidate: mocks.invalidate.byId },
        stream: { invalidate: mocks.invalidate.stream },
        heartRateContext: { invalidate: mocks.invalidate.heartRateContext },
        hrZones: { invalidate: mocks.invalidate.hrZones },
        powerZones: { invalidate: mocks.invalidate.powerZones },
        powerWork: { invalidate: mocks.invalidate.powerWork },
        strengthExercises: { invalidate: mocks.invalidate.strengthExercises },
        list: { invalidate: mocks.invalidate.list },
        recomputeStatus: { reset: mocks.resetStatus },
      },
      calendar: {
        weekListV2: { invalidate: mocks.invalidate.weekListV2 },
        activityOverview: { invalidate: mocks.invalidate.activityOverview },
      },
    }),
    activity: {
      recompute: {
        useMutation: (options: {
          onSuccess: (result: { success: boolean; analyticsJobId: string | null }) => Promise<void>;
          onError: (error: Error) => void;
        }) => ({
          mutate: (input: { id: string }) => {
            mocks.mutate(input);
            if (mocks.mutationError) options.onError(mocks.mutationError);
            else void options.onSuccess(mocks.mutationResult);
          },
          isPending: false,
        }),
      },
      recomputeStatus: {
        useQuery: (input: { jobId: string }, options: { enabled: boolean }) => {
          mocks.statusQuery(input, options);
          return options.enabled
            ? { data: mocks.status, error: mocks.statusError }
            : { data: undefined, error: null };
        },
      },
    },
  },
}));

vi.mock("../../../lib/telemetry.ts", () => ({ captureException: mocks.captureException }));

function detailInvalidations() {
  return Object.values(mocks.invalidate).reduce(
    (count, invalidate) => count + invalidate.mock.calls.length,
    0,
  );
}

function recomputeButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name: /^Recomput/ });
}

function lastStatusQueryOptions(): {
  enabled: boolean;
  refetchInterval: (query: {
    state: { data?: RecomputeStatus; error: Error | null };
  }) => number | false;
} {
  return mocks.statusQuery.mock.lastCall?.[1];
}

describe("RecomputeActivityButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mutationResult = { success: true, analyticsJobId: "recompute-job-1" };
    mocks.mutationError = null;
    mocks.status = { status: "pending", error: null };
    mocks.statusError = null;
    mocks.resetStatus.mockResolvedValue(undefined);
    for (const invalidate of Object.values(mocks.invalidate)) {
      invalidate.mockResolvedValue(undefined);
    }
  });
  afterEach(() => cleanup());

  it("keeps cached metrics and polls the job while the recompute runs", async () => {
    render(<RecomputeActivityButton activityId="activity-1" />);

    fireEvent.click(recomputeButton());

    expect(mocks.mutate).toHaveBeenCalledWith({ id: "activity-1" });
    await waitFor(() => expect(recomputeButton().textContent).toBe("Recomputing..."));
    expect(recomputeButton().disabled).toBe(true);
    expect(mocks.resetStatus).toHaveBeenCalledWith({ jobId: "recompute-job-1" });
    expect(mocks.statusQuery).toHaveBeenLastCalledWith(
      { jobId: "recompute-job-1" },
      expect.objectContaining({ enabled: true }),
    );
    expect(detailInvalidations()).toBe(0);
  });

  it("polls every 2 seconds only while the job is pending", () => {
    render(<RecomputeActivityButton activityId="activity-1" />);
    const { refetchInterval } = lastStatusQueryOptions();

    expect(
      refetchInterval({ state: { data: { status: "pending", error: null }, error: null } }),
    ).toBe(2_000);
    expect(
      refetchInterval({ state: { data: { status: "completed", error: null }, error: null } }),
    ).toBe(false);
    expect(
      refetchInterval({ state: { data: { status: "failed", error: "x" }, error: null } }),
    ).toBe(false);
    expect(
      refetchInterval({
        state: { data: { status: "pending", error: null }, error: new Error("unavailable") },
      }),
    ).toBe(false);
  });

  it("refreshes the activity detail queries once the job completes, then stops polling", async () => {
    mocks.status = { status: "completed", error: null };
    render(<RecomputeActivityButton activityId="activity-1" />);

    fireEvent.click(recomputeButton());

    await waitFor(() => expect(mocks.invalidate.byId).toHaveBeenCalledWith({ id: "activity-1" }));
    await waitFor(() => expect(recomputeButton().textContent).toBe("Recompute"));
    expect(mocks.invalidate.stream).toHaveBeenCalledWith({ id: "activity-1", maxPoints: 500 });
    expect(mocks.invalidate.heartRateContext).toHaveBeenCalledWith({ id: "activity-1" });
    expect(mocks.invalidate.hrZones).toHaveBeenCalledWith({ id: "activity-1" });
    expect(mocks.invalidate.powerZones).toHaveBeenCalledWith({ id: "activity-1" });
    expect(mocks.invalidate.powerWork).toHaveBeenCalledWith({ id: "activity-1" });
    expect(mocks.invalidate.strengthExercises).toHaveBeenCalledWith({ id: "activity-1" });
    expect(mocks.invalidate.list).toHaveBeenCalledOnce();
    expect(mocks.invalidate.weekListV2).toHaveBeenCalledOnce();
    expect(mocks.invalidate.activityOverview).toHaveBeenCalledOnce();
    expect(lastStatusQueryOptions().enabled).toBe(false);
    expect(recomputeButton().disabled).toBe(false);
  });

  it("keeps the button busy until the completion refresh finishes", async () => {
    mocks.status = { status: "completed", error: null };
    let finishRefresh = () => {};
    mocks.invalidate.byId.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRefresh = resolve;
      }),
    );
    render(<RecomputeActivityButton activityId="activity-1" />);

    fireEvent.click(recomputeButton());

    await waitFor(() => expect(mocks.invalidate.byId).toHaveBeenCalled());
    expect(recomputeButton().disabled).toBe(true);
    await act(async () => finishRefresh());
    expect(recomputeButton().disabled).toBe(false);
  });

  it("shows the server message when the job fails and does not refresh", async () => {
    mocks.status = {
      status: "failed",
      error: "Recomputing this activity failed. Use Recompute to try again.",
    };
    render(<RecomputeActivityButton activityId="activity-1" />);

    fireEvent.click(recomputeButton());

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Recomputing this activity failed. Use Recompute to try again.",
      ),
    );
    expect(recomputeButton().disabled).toBe(false);
    expect(detailInvalidations()).toBe(0);
    expect(lastStatusQueryOptions().enabled).toBe(false);
  });

  it("shows the server message when the job status is unavailable", async () => {
    mocks.statusError = new Error(
      "Recompute status is unavailable. Reload the activity to check its metrics.",
    );
    render(<RecomputeActivityButton activityId="activity-1" />);

    fireEvent.click(recomputeButton());

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Recompute status is unavailable. Reload the activity to check its metrics.",
      ),
    );
    expect(recomputeButton().disabled).toBe(false);
    expect(lastStatusQueryOptions().enabled).toBe(false);
  });

  it("reports a failed request and shows the server message", async () => {
    mocks.mutationError = new Error("Network unavailable");
    render(<RecomputeActivityButton activityId="activity-1" />);

    fireEvent.click(recomputeButton());

    expect(screen.getByRole("alert").textContent).toBe("Network unavailable");
    expect(mocks.captureException).toHaveBeenCalledWith(mocks.mutationError, {
      context: "activity-recompute",
    });
    expect(recomputeButton().disabled).toBe(false);
  });

  it("clears the previous error when the user tries again", async () => {
    mocks.mutationError = new Error("Network unavailable");
    render(<RecomputeActivityButton activityId="activity-1" />);
    fireEvent.click(recomputeButton());
    expect(screen.getByRole("alert")).toBeTruthy();

    mocks.mutationError = null;
    fireEvent.click(recomputeButton());

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("refreshes immediately when no job was queued", async () => {
    mocks.mutationResult = { success: true, analyticsJobId: null };
    render(<RecomputeActivityButton activityId="activity-1" />);

    fireEvent.click(recomputeButton());

    await waitFor(() => expect(mocks.invalidate.byId).toHaveBeenCalledWith({ id: "activity-1" }));
    expect(mocks.resetStatus).not.toHaveBeenCalled();
    expect(lastStatusQueryOptions().enabled).toBe(false);
  });
});
