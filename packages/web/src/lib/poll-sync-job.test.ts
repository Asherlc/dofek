import { afterEach, describe, expect, it, vi } from "vitest";
import { pollSyncJob, type SyncJobStatus } from "../lib/poll-sync-job.ts";

function createDeferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolvePromise) throw new Error("Deferred promise resolver is unavailable");
      resolvePromise(value);
    },
    reject(reason: unknown) {
      if (!rejectPromise) throw new Error("Deferred promise rejecter is unavailable");
      rejectPromise(reason);
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("pollSyncJob", () => {
  it("resets syncing providers when job is null (server restart)", async () => {
    const states: Record<string, string> = { wahoo: "syncing", whoop: "syncing" };
    const updateState = vi.fn((id: string, state: { status: string }) => {
      states[id] = state.status;
    });
    const fetchStatus = vi.fn().mockResolvedValue(null);
    const onComplete = vi.fn();

    await pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo", "whoop"],
      fetchStatus,
      updateState,
      onComplete,
    });

    // Both providers should be reset to error, not left in syncing
    expect(updateState).toHaveBeenCalledWith("wahoo", expect.objectContaining({ status: "error" }));
    expect(updateState).toHaveBeenCalledWith("whoop", expect.objectContaining({ status: "error" }));
  });

  it("preserves syncing state, shows the server error, and retries", async () => {
    const updateState = vi.fn();
    const fetchStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("Sync status is temporarily unavailable. Please try again."))
      .mockResolvedValueOnce({
        status: "completed",
        providers: { wahoo: { status: "done", message: "5 synced" } },
      });
    const onComplete = vi.fn();

    await pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo"],
      fetchStatus,
      updateState,
      onComplete,
      pollIntervalMs: 0,
    });

    expect(updateState).toHaveBeenNthCalledWith(1, "wahoo", {
      status: "syncing",
      message: "Sync status is temporarily unavailable. Please try again.",
    });
    expect(updateState).toHaveBeenNthCalledWith(2, "wahoo", {
      status: "done",
      message: "5 synced",
    });
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("reports transient failures and stops retrying after cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pollingError = new Error("Sync status is temporarily unavailable. Please try again.");
    const updateState = vi.fn();
    const fetchStatus = vi
      .fn()
      .mockRejectedValueOnce(pollingError)
      .mockResolvedValueOnce({
        status: "completed",
        providers: { wahoo: { status: "done", message: "5 synced" } },
      });
    const onComplete = vi.fn();
    const onError = vi.fn();

    const polling = pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo"],
      fetchStatus,
      updateState,
      onComplete,
      onError,
      pollIntervalMs: 1000,
      signal: controller.signal,
    });
    let pollingFinished = false;
    void polling.then(() => {
      pollingFinished = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledWith(pollingError);
    expect(updateState).toHaveBeenCalledOnce();

    controller.abort();
    await flushMicrotasks();

    expect(pollingFinished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await polling;

    expect(fetchStatus).toHaveBeenCalledOnce();
    expect(updateState).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not fetch when cancellation already occurred", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchStatus = vi.fn();
    const updateState = vi.fn();
    const onComplete = vi.fn();

    await pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo"],
      fetchStatus,
      updateState,
      onComplete,
      signal: controller.signal,
    });

    expect(fetchStatus).not.toHaveBeenCalled();
    expect(updateState).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("stops without reporting when cancellation occurs during a rejected fetch", async () => {
    const controller = new AbortController();
    const deferredStatus = createDeferred<SyncJobStatus | null>();
    const fetchStatus = vi.fn().mockReturnValue(deferredStatus.promise);
    const updateState = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();
    const polling = pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo"],
      fetchStatus,
      updateState,
      onComplete,
      onError,
      signal: controller.signal,
    });

    controller.abort();
    deferredStatus.reject(new Error("Redis connection refused"));
    await polling;

    expect(onError).not.toHaveBeenCalled();
    expect(updateState).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("stops without callbacks when cancellation occurs during a resolved fetch", async () => {
    const controller = new AbortController();
    const deferredStatus = createDeferred<SyncJobStatus | null>();
    const fetchStatus = vi.fn().mockReturnValue(deferredStatus.promise);
    const updateState = vi.fn();
    const onComplete = vi.fn();
    const polling = pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo"],
      fetchStatus,
      updateState,
      onComplete,
      signal: controller.signal,
    });

    controller.abort();
    deferredStatus.resolve({
      status: "completed",
      providers: { wahoo: { status: "done", message: "5 synced" } },
    });
    await polling;

    expect(updateState).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("stops a null reset when a state callback cancels polling", async () => {
    const controller = new AbortController();
    const updateState = vi.fn(() => controller.abort());

    await pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo", "whoop"],
      fetchStatus: vi.fn().mockResolvedValue(null),
      updateState,
      onComplete: vi.fn(),
      signal: controller.signal,
    });

    expect(updateState).toHaveBeenCalledOnce();
    expect(updateState).toHaveBeenCalledWith("wahoo", {
      status: "error",
      message: "Lost sync status",
    });
  });

  it("stops transient error updates when a state callback cancels polling", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const updateState = vi.fn(() => controller.abort());

    const polling = pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo", "whoop"],
      fetchStatus: vi.fn().mockRejectedValue(new Error("Redis connection refused")),
      updateState,
      onComplete: vi.fn(),
      pollIntervalMs: 1000,
      signal: controller.signal,
    });
    await flushMicrotasks();

    expect(updateState).toHaveBeenCalledOnce();
    expect(updateState).toHaveBeenCalledWith(
      "wahoo",
      expect.objectContaining({ status: "syncing" }),
    );
    expect(vi.getTimerCount()).toBe(0);
    await polling;
  });

  it("does not schedule another retry when the final error update cancels polling", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const polling = pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo"],
      fetchStatus: vi.fn().mockRejectedValue(new Error("Redis connection refused")),
      updateState: vi.fn(() => controller.abort()),
      onComplete: vi.fn(),
      pollIntervalMs: 1000,
      signal: controller.signal,
    });
    await flushMicrotasks();

    expect(controller.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await polling;
  });

  it("stops provider updates when a state callback cancels polling", async () => {
    const controller = new AbortController();
    const updateState = vi.fn(() => controller.abort());
    const onComplete = vi.fn();

    await pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo", "whoop"],
      fetchStatus: vi.fn().mockResolvedValue({
        status: "completed",
        providers: {
          wahoo: { status: "done", message: "5 synced" },
          whoop: { status: "done", message: "7 synced" },
        },
      }),
      updateState,
      onComplete,
      signal: controller.signal,
    });

    expect(updateState).toHaveBeenCalledOnce();
    expect(updateState).toHaveBeenCalledWith("wahoo", {
      status: "done",
      message: "5 synced",
    });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not complete when the terminal provider callback cancels polling", async () => {
    const controller = new AbortController();
    const onComplete = vi.fn();

    await pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo"],
      fetchStatus: vi.fn().mockResolvedValue({
        status: "completed",
        providers: { wahoo: { status: "done", message: "5 synced" } },
      }),
      updateState: vi.fn(() => controller.abort()),
      onComplete,
      signal: controller.signal,
    });

    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not schedule another normal poll when the final state callback cancels polling", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchStatus = vi.fn().mockResolvedValue({
      status: "running",
      providers: { wahoo: { status: "running" } },
    });
    const polling = pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo"],
      fetchStatus,
      updateState: vi.fn(() => controller.abort()),
      onComplete: vi.fn(),
      pollIntervalMs: 1000,
      signal: controller.signal,
    });
    await flushMicrotasks();

    expect(controller.signal.aborted).toBe(true);
    expect(fetchStatus).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await polling;
  });

  it("continues only after a positive poll interval and removes the abort listener", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, "addEventListener");
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({
        status: "running",
        providers: { wahoo: { status: "running" } },
      })
      .mockResolvedValueOnce({
        status: "completed",
        providers: { wahoo: { status: "done" } },
      });
    const onComplete = vi.fn();
    const polling = pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo"],
      fetchStatus,
      updateState: vi.fn(),
      onComplete,
      pollIntervalMs: 1000,
      signal: controller.signal,
    });
    await flushMicrotasks();

    expect(fetchStatus).toHaveBeenCalledOnce();
    expect(addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchStatus).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await polling;

    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("uses no timer when the poll interval is zero", async () => {
    vi.useFakeTimers();
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: "running", providers: {} })
      .mockResolvedValueOnce({ status: "completed", providers: {} });

    const polling = pollSyncJob({
      jobId: "sync-123",
      providerIds: [],
      fetchStatus,
      updateState: vi.fn(),
      onComplete: vi.fn(),
      pollIntervalMs: 0,
    });
    await flushMicrotasks();

    expect(vi.getTimerCount()).toBe(0);
    await polling;
  });

  it("continues after a positive poll interval without a cancellation signal", async () => {
    vi.useFakeTimers();
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: "running", providers: {} })
      .mockResolvedValueOnce({ status: "completed", providers: {} });
    const onComplete = vi.fn();
    const polling = pollSyncJob({
      jobId: "sync-123",
      providerIds: [],
      fetchStatus,
      updateState: vi.fn(),
      onComplete,
      pollIntervalMs: 1000,
    });
    await flushMicrotasks();

    expect(fetchStatus).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    await polling;

    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("handles cancellation immediately before the abort listener is registered", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const nativeAddEventListener = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "addEventListener").mockImplementationOnce(
      (type, listener, options) => {
        controller.abort();
        nativeAddEventListener(type, listener, options);
      },
    );
    const fetchStatus = vi.fn().mockResolvedValue({
      status: "running",
      providers: { wahoo: { status: "running" } },
    });
    const polling = pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo"],
      fetchStatus,
      updateState: vi.fn(),
      onComplete: vi.fn(),
      pollIntervalMs: 1000,
      signal: controller.signal,
    });
    let pollingFinished = false;
    void polling.then(() => {
      pollingFinished = true;
    });
    await flushMicrotasks();

    expect(controller.signal.aborted).toBe(true);
    expect(pollingFinished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchStatus).toHaveBeenCalledOnce();
    await polling;
  });

  it("preserves last-known provider states and percentage across transient errors", async () => {
    const updateState = vi.fn();
    const unavailableMessage = "Sync status is temporarily unavailable. Please try again.";
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({
        status: "running",
        percentage: 42,
        providers: {
          wahoo: { status: "done", message: "5 synced" },
          whoop: { status: "running", message: "Fetching activities..." },
        },
      })
      .mockRejectedValueOnce(new Error(unavailableMessage))
      .mockResolvedValueOnce({
        status: "completed",
        providers: {
          wahoo: { status: "done", message: "5 synced" },
          whoop: { status: "done", message: "7 synced" },
        },
      });
    const onComplete = vi.fn();

    await pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo", "whoop"],
      fetchStatus,
      updateState,
      onComplete,
      pollIntervalMs: 0,
    });

    expect(updateState).toHaveBeenNthCalledWith(3, "wahoo", {
      status: "done",
      message: unavailableMessage,
    });
    expect(updateState).toHaveBeenNthCalledWith(4, "whoop", {
      status: "syncing",
      message: unavailableMessage,
      percentage: 42,
    });
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("updates provider states from job and calls onComplete when done", async () => {
    const updateState = vi.fn();
    const doneJob: SyncJobStatus = {
      status: "completed",
      providers: {
        wahoo: { status: "done", message: "5 synced" },
        whoop: { status: "error", message: "Auth failed" },
      },
    };
    const fetchStatus = vi.fn().mockResolvedValue(doneJob);
    const onComplete = vi.fn();

    await pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo", "whoop"],
      fetchStatus,
      updateState,
      onComplete,
    });

    expect(updateState).toHaveBeenCalledWith("wahoo", { status: "done", message: "5 synced" });
    expect(updateState).toHaveBeenCalledWith("whoop", { status: "error", message: "Auth failed" });
    expect(onComplete).toHaveBeenCalled();
  });

  it("polls repeatedly until job completes", async () => {
    const updateState = vi.fn();
    const onComplete = vi.fn();

    const runningJob: SyncJobStatus = {
      status: "running",
      providers: { wahoo: { status: "running" } },
    };
    const doneJob: SyncJobStatus = {
      status: "completed",
      providers: { wahoo: { status: "done", message: "3 synced" } },
    };

    const fetchStatus = vi.fn().mockResolvedValueOnce(runningJob).mockResolvedValueOnce(doneJob);

    await pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo"],
      fetchStatus,
      updateState,
      onComplete,
      pollIntervalMs: 0, // no delay in tests
    });

    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalled();
  });

  it("sets resetSyncing message to 'Lost sync status'", async () => {
    const updateState = vi.fn();
    const fetchStatus = vi.fn().mockResolvedValue(null);

    await pollSyncJob({
      jobId: "j1",
      providerIds: ["p1"],
      fetchStatus,
      updateState,
      onComplete: vi.fn(),
    });

    expect(updateState).toHaveBeenCalledWith("p1", {
      status: "error",
      message: "Lost sync status",
    });
  });

  it("maps provider done status to 'done' not 'error'", async () => {
    const updateState = vi.fn();
    const fetchStatus = vi.fn().mockResolvedValue({
      status: "completed",
      providers: { p1: { status: "done" } },
    });

    await pollSyncJob({
      jobId: "j1",
      providerIds: ["p1"],
      fetchStatus,
      updateState,
      onComplete: vi.fn(),
    });

    expect(updateState).toHaveBeenCalledWith("p1", { status: "done", message: undefined });
  });

  it("maps provider error status to 'error' and passes message", async () => {
    const updateState = vi.fn();
    const fetchStatus = vi.fn().mockResolvedValue({
      status: "completed",
      providers: { p1: { status: "error", message: "Auth expired" } },
    });

    await pollSyncJob({
      jobId: "j1",
      providerIds: ["p1"],
      fetchStatus,
      updateState,
      onComplete: vi.fn(),
    });

    expect(updateState).toHaveBeenCalledWith("p1", { status: "error", message: "Auth expired" });
  });

  it("maps running provider to syncing with 'Syncing...' message", async () => {
    const updateState = vi.fn();
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({
        status: "running",
        providers: { p1: { status: "running" } },
      })
      .mockResolvedValueOnce({
        status: "completed",
        providers: { p1: { status: "done" } },
      });

    await pollSyncJob({
      jobId: "j1",
      providerIds: ["p1"],
      fetchStatus,
      updateState,
      onComplete: vi.fn(),
      pollIntervalMs: 0,
    });

    expect(updateState).toHaveBeenCalledWith("p1", {
      status: "syncing",
      message: "Syncing...",
      percentage: undefined,
    });
  });

  it("passes percentage when provider is running", async () => {
    const updateState = vi.fn();
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({
        status: "running",
        percentage: 42,
        providers: { p1: { status: "running", message: "Fetching activities..." } },
      })
      .mockResolvedValueOnce({
        status: "completed",
        providers: { p1: { status: "done" } },
      });

    await pollSyncJob({
      jobId: "j1",
      providerIds: ["p1"],
      fetchStatus,
      updateState,
      onComplete: vi.fn(),
      pollIntervalMs: 0,
    });

    expect(updateState).toHaveBeenCalledWith("p1", {
      status: "syncing",
      message: "Fetching activities...",
      percentage: 42,
    });
  });

  it("does not include percentage for done/error states", async () => {
    const updateState = vi.fn();
    const fetchStatus = vi.fn().mockResolvedValue({
      status: "completed",
      percentage: 100,
      providers: {
        p1: { status: "done", message: "5 synced" },
        p2: { status: "error", message: "Auth failed" },
      },
    });

    await pollSyncJob({
      jobId: "j1",
      providerIds: ["p1", "p2"],
      fetchStatus,
      updateState,
      onComplete: vi.fn(),
    });

    expect(updateState).toHaveBeenCalledWith("p1", { status: "done", message: "5 synced" });
    expect(updateState).toHaveBeenCalledWith("p2", { status: "error", message: "Auth failed" });
  });

  it("does not call updateState for pending providers", async () => {
    const updateState = vi.fn();
    const fetchStatus = vi.fn().mockResolvedValue({
      status: "completed",
      providers: { p1: { status: "pending" } },
    });

    await pollSyncJob({
      jobId: "j1",
      providerIds: ["p1"],
      fetchStatus,
      updateState,
      onComplete: vi.fn(),
    });

    expect(updateState).not.toHaveBeenCalled();
  });

  it("calls onComplete when job status is failed", async () => {
    const onComplete = vi.fn();
    const fetchStatus = vi.fn().mockResolvedValue({
      status: "failed",
      providers: {},
    });

    await pollSyncJob({
      jobId: "j1",
      providerIds: [],
      fetchStatus,
      updateState: vi.fn(),
      onComplete,
    });

    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("passes through undefined message when provider has no message", async () => {
    const updateState = vi.fn();
    const fetchStatus = vi.fn().mockResolvedValue({
      status: "completed",
      providers: { p1: { status: "done", message: undefined } },
    });

    await pollSyncJob({
      jobId: "j1",
      providerIds: ["p1"],
      fetchStatus,
      updateState,
      onComplete: vi.fn(),
    });

    const call = updateState.mock.calls[0];
    expect(call?.[1].message).toBeUndefined();
  });
});
