import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncCoordinator } from "./sync-coordinator.ts";
import { deferred } from "./test-helpers.ts";

afterEach(() => vi.useRealTimers());

describe("SyncCoordinator", () => {
  it("coalesces overlapping triggers into one in-flight drain and one rerun", async () => {
    const firstDrain = deferred();
    const drain = vi
      .fn<(reasons: readonly string[]) => Promise<boolean>>()
      .mockImplementationOnce(async () => {
        await firstDrain.promise;
        return true;
      })
      .mockResolvedValueOnce(true);
    const coordinator = new SyncCoordinator(drain);

    const background = coordinator.requestDrain("background");
    const onOpen = coordinator.requestDrain("on-open");
    const manual = coordinator.requestDrain("manual");

    expect(drain).toHaveBeenCalledTimes(1);
    expect(drain).toHaveBeenNthCalledWith(1, ["background"]);

    firstDrain.resolve();
    await Promise.all([background, onOpen, manual]);

    expect(drain).toHaveBeenCalledTimes(2);
    expect(drain).toHaveBeenNthCalledWith(2, ["on-open", "manual"]);
  });

  it("deduplicates a reason within the queued rerun", async () => {
    const firstDrain = deferred();
    const drain = vi
      .fn<(reasons: readonly string[]) => Promise<boolean>>()
      .mockImplementationOnce(async () => {
        await firstDrain.promise;
        return true;
      })
      .mockResolvedValueOnce(true);
    const coordinator = new SyncCoordinator(drain);

    const first = coordinator.requestDrain("on-connect");
    const duplicate = coordinator.requestDrain("on-connect");
    firstDrain.resolve();
    await Promise.all([first, duplicate]);

    expect(drain).toHaveBeenCalledTimes(2);
    expect(drain).toHaveBeenNthCalledWith(2, ["on-connect"]);
  });

  it("propagates failure and permits a later retry", async () => {
    const failure = new Error("server unavailable");
    const drain = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(true);
    const coordinator = new SyncCoordinator(drain);

    await expect(coordinator.requestDrain("manual")).rejects.toBe(failure);
    await expect(coordinator.requestDrain("manual")).resolves.toBeUndefined();
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it("does not strand a request arriving during the idle handoff", async () => {
    const firstDrain = deferred();
    const drain = vi
      .fn<(reasons: readonly string[]) => Promise<boolean>>()
      .mockImplementationOnce(async () => {
        await firstDrain.promise;
        return true;
      })
      .mockResolvedValueOnce(true);
    const coordinator = new SyncCoordinator(drain);

    const first = coordinator.requestDrain("first");
    let handoff: Promise<void> | undefined;
    void firstDrain.promise.then(() => {
      handoff = coordinator.requestDrain("handoff");
    });
    firstDrain.resolve();
    await first;
    await Promise.resolve();
    await handoff;

    expect(drain).toHaveBeenCalledTimes(2);
    expect(drain).toHaveBeenNthCalledWith(2, ["handoff"]);
  });

  it("retries handled failures with bounded exponential backoff", async () => {
    vi.useFakeTimers();
    const onRetryError = vi.fn();
    const drain = vi
      .fn<(reasons: readonly string[]) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const coordinator = new SyncCoordinator(drain, {
      retryBaseDelayMs: 100,
      maxRetryAttempts: 2,
      onRetryError,
    });

    await coordinator.requestDrain("watch-receipt");
    expect(drain).toHaveBeenCalledExactlyOnceWith(["watch-receipt"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(drain).toHaveBeenNthCalledWith(2, ["retry"]);
    await vi.advanceTimersByTimeAsync(199);
    expect(drain).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenNthCalledWith(3, ["retry"]);
    await vi.runAllTimersAsync();
    expect(drain).toHaveBeenCalledTimes(3);
    expect(onRetryError).not.toHaveBeenCalled();
  });

  it("reports an unexpected failure from a scheduled retry", async () => {
    vi.useFakeTimers();
    const failure = new Error("retry crashed");
    const onRetryError = vi.fn();
    const drain = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(failure);
    const coordinator = new SyncCoordinator(drain, {
      retryBaseDelayMs: 100,
      maxRetryAttempts: 1,
      onRetryError,
    });

    await coordinator.requestDrain("manual");
    await vi.advanceTimersByTimeAsync(100);

    expect(onRetryError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("cancels a scheduled retry when a new delivery trigger succeeds", async () => {
    vi.useFakeTimers();
    const drain = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const coordinator = new SyncCoordinator(drain, {
      retryBaseDelayMs: 100,
      maxRetryAttempts: 2,
      onRetryError: vi.fn(),
    });

    await coordinator.requestDrain("watch-receipt");
    await coordinator.requestDrain("connection-restored");
    await vi.runAllTimersAsync();

    expect(drain).toHaveBeenCalledTimes(2);
    expect(drain).toHaveBeenNthCalledWith(2, ["connection-restored"]);
  });

  it("stops scheduling after the configured retry limit", async () => {
    vi.useFakeTimers();
    const drain = vi.fn(async () => false);
    const coordinator = new SyncCoordinator(drain, {
      retryBaseDelayMs: 100,
      maxRetryAttempts: 2,
      onRetryError: vi.fn(),
    });

    await coordinator.requestDrain("watch-receipt");
    await vi.runAllTimersAsync();

    expect(drain).toHaveBeenCalledTimes(3);
    expect(drain).toHaveBeenNthCalledWith(2, ["retry"]);
    expect(drain).toHaveBeenNthCalledWith(3, ["retry"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule retries unless retry policy is configured", async () => {
    vi.useFakeTimers();
    const drain = vi.fn(async () => false);
    const coordinator = new SyncCoordinator(drain);

    await coordinator.requestDrain("watch-receipt");
    await vi.runAllTimersAsync();

    expect(drain).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
