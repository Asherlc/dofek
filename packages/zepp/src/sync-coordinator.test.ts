import { describe, expect, it, vi } from "vitest";
import { SyncCoordinator } from "./sync-coordinator.ts";

function deferred() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return {
    promise,
    resolve: () => {
      if (!resolve) throw new Error("Deferred promise was not initialized");
      resolve();
    },
  };
}

describe("SyncCoordinator", () => {
  it("coalesces overlapping triggers into one in-flight drain and one rerun", async () => {
    const firstDrain = deferred();
    const drain = vi
      .fn<(reasons: readonly string[]) => Promise<void>>()
      .mockImplementationOnce(async () => firstDrain.promise)
      .mockResolvedValueOnce(undefined);
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
      .fn<(reasons: readonly string[]) => Promise<void>>()
      .mockImplementationOnce(async () => firstDrain.promise)
      .mockResolvedValueOnce(undefined);
    const coordinator = new SyncCoordinator(drain);

    const first = coordinator.requestDrain("on-connect");
    const duplicate = coordinator.requestDrain("on-connect");
    firstDrain.resolve();
    await Promise.all([first, duplicate]);

    expect(drain).toHaveBeenNthCalledWith(2, ["on-connect"]);
  });

  it("propagates failure and permits a later retry", async () => {
    const failure = new Error("server unavailable");
    const drain = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const coordinator = new SyncCoordinator(drain);

    await expect(coordinator.requestDrain("manual")).rejects.toBe(failure);
    await expect(coordinator.requestDrain("manual")).resolves.toBeUndefined();
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it("does not strand a request arriving during the idle handoff", async () => {
    const firstDrain = deferred();
    const drain = vi
      .fn<(reasons: readonly string[]) => Promise<void>>()
      .mockImplementationOnce(async () => firstDrain.promise)
      .mockResolvedValueOnce(undefined);
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
});
