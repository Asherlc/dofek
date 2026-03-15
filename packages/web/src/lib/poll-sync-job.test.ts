import { describe, expect, it, vi } from "vitest";
import { pollSyncJob, type SyncJobStatus } from "../lib/poll-sync-job.ts";

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

  it("resets syncing providers when fetch throws", async () => {
    const updateState = vi.fn();
    const fetchStatus = vi.fn().mockRejectedValue(new Error("Network error"));
    const onComplete = vi.fn();

    await pollSyncJob({
      jobId: "sync-123",
      providerIds: ["wahoo"],
      fetchStatus,
      updateState,
      onComplete,
    });

    expect(updateState).toHaveBeenCalledWith("wahoo", expect.objectContaining({ status: "error" }));
  });

  it("updates provider states from job and calls onComplete when done", async () => {
    const updateState = vi.fn();
    const doneJob: SyncJobStatus = {
      status: "done",
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
      status: "done",
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
      status: "done",
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
      status: "done",
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
        status: "done",
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

    expect(updateState).toHaveBeenCalledWith("p1", { status: "syncing", message: "Syncing..." });
  });

  it("does not call updateState for pending providers", async () => {
    const updateState = vi.fn();
    const fetchStatus = vi.fn().mockResolvedValue({
      status: "done",
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

  it("calls onComplete when job status is error", async () => {
    const onComplete = vi.fn();
    const fetchStatus = vi.fn().mockResolvedValue({
      status: "error",
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
      status: "done",
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
