import { WaitingError, type Worker } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureException } from "../lib/error-reporting.ts";
import { isPortableSyncHandoffActive, yieldSyncToPortableWorker } from "./portable-sync-slot.ts";
import type { SyncJobData } from "./queues.ts";

vi.mock("../lib/error-reporting.ts", () => ({
  captureException: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** Equivalent to Promise.withResolvers() but compatible with ES2022 lib target. */
function deferred<Value>() {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) {
    throw new Error("Deferred promise resolver was not initialized");
  }
  return { promise, resolve: resolvePromise };
}

function makeYieldWorker(closing: Worker<SyncJobData>["closing"] = undefined) {
  let paused = false;
  return {
    closing,
    isPaused: vi.fn(() => paused),
    pause: vi.fn(async () => {
      paused = true;
    }),
    resume: vi.fn(async () => {
      paused = false;
    }),
  };
}

function makeYieldJob(attemptsStarted = 1) {
  return {
    attemptsStarted,
    moveToWait: vi.fn().mockResolvedValue(0),
  };
}

function makeSlot(offerResult: boolean | Error = true) {
  return {
    renew: vi.fn().mockResolvedValue(null),
    offer: vi.fn().mockImplementation(async () => {
      if (offerResult instanceof Error) throw offerResult;
      return offerResult;
    }),
    take: vi.fn().mockResolvedValue(true),
  };
}

describe("yieldSyncToPortableWorker handoff mark", () => {
  it("marks the paused worker when the resume timer is scheduled", async () => {
    const worker = makeYieldWorker();
    const job = makeYieldJob();

    await expect(
      yieldSyncToPortableWorker(async () => makeSlot(true), worker, "tension", job, "token-1"),
    ).rejects.toBeInstanceOf(WaitingError);

    expect(worker.pause).toHaveBeenCalledWith(true);
    expect(job.moveToWait).toHaveBeenCalledWith("token-1");
    expect(isPortableSyncHandoffActive(worker)).toBe(true);
  });

  it("treats the monotonic deadline as exclusive before the resume callback runs", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    let currentMs = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => currentMs);

    const worker = makeYieldWorker();
    const job = makeYieldJob();

    await expect(
      yieldSyncToPortableWorker(async () => makeSlot(true), worker, "tension", job, "token-1"),
    ).rejects.toBeInstanceOf(WaitingError);

    // Deadline is performance.now() + 3000 at schedule time → 4000.
    currentMs = 3_999;
    expect(isPortableSyncHandoffActive(worker)).toBe(true);
    expect(worker.resume).not.toHaveBeenCalled();

    currentMs = 4_000;
    expect(isPortableSyncHandoffActive(worker)).toBe(false);
    expect(worker.resume).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(worker.resume).toHaveBeenCalledOnce();
    expect(isPortableSyncHandoffActive(worker)).toBe(false);
  });

  it("does not treat a different worker as an active handoff", async () => {
    const worker = makeYieldWorker();
    const other = makeYieldWorker();
    const job = makeYieldJob();

    await expect(
      yieldSyncToPortableWorker(async () => makeSlot(true), worker, "tension", job, "token-1"),
    ).rejects.toBeInstanceOf(WaitingError);

    expect(isPortableSyncHandoffActive(other)).toBe(false);
  });

  it("ignores a stale resume timer after a later accepted handoff", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    let currentMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => currentMs);

    const worker = makeYieldWorker();

    currentMs = 0;
    await expect(
      yieldSyncToPortableWorker(
        async () => makeSlot(true),
        worker,
        "fatsecret",
        makeYieldJob(),
        "token-1",
      ),
    ).rejects.toBeInstanceOf(WaitingError);

    currentMs = 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(
      yieldSyncToPortableWorker(
        async () => makeSlot(true),
        worker,
        "fatsecret",
        makeYieldJob(),
        "token-2",
      ),
    ).rejects.toBeInstanceOf(WaitingError);

    currentMs = 3_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(worker.resume).not.toHaveBeenCalled();

    currentMs = 4_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(worker.resume).toHaveBeenCalledOnce();
    expect(isPortableSyncHandoffActive(worker)).toBe(false);
  });

  it("does not resume while a later accepted handoff is still moving to wait", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    let currentMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => currentMs);

    const worker = makeYieldWorker();

    currentMs = 0;
    await expect(
      yieldSyncToPortableWorker(
        async () => makeSlot(true),
        worker,
        "fatsecret",
        makeYieldJob(),
        "token-1",
      ),
    ).rejects.toBeInstanceOf(WaitingError);

    currentMs = 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    const deferredMove = deferred<number>();
    const secondHandoff = yieldSyncToPortableWorker(
      async () => makeSlot(true),
      worker,
      "fatsecret",
      {
        attemptsStarted: 1,
        moveToWait: vi.fn(() => deferredMove.promise),
      },
      "token-2",
    );
    await vi.waitFor(() => {
      expect(worker.pause).toHaveBeenCalledTimes(2);
    });

    currentMs = 3_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(worker.resume).not.toHaveBeenCalled();

    deferredMove.resolve(0);
    await expect(secondHandoff).rejects.toBeInstanceOf(WaitingError);
    expect(isPortableSyncHandoffActive(worker)).toBe(true);

    currentMs = 5_999;
    await vi.advanceTimersByTimeAsync(2_999);
    expect(worker.resume).not.toHaveBeenCalled();
    expect(isPortableSyncHandoffActive(worker)).toBe(true);

    currentMs = 6_000;
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.resume).toHaveBeenCalledOnce();
    expect(isPortableSyncHandoffActive(worker)).toBe(false);
  });

  it("schedules a resume fallback when pause fails but the worker remains paused", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const worker = makeYieldWorker();
    worker.pause.mockRejectedValueOnce(new Error("pause failed"));
    worker.isPaused.mockReturnValue(true);

    await expect(
      yieldSyncToPortableWorker(
        async () => makeSlot(true),
        worker,
        "garmin",
        makeYieldJob(),
        "token-1",
      ),
    ).rejects.toThrow("pause failed");

    expect(isPortableSyncHandoffActive(worker)).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(worker.resume).toHaveBeenCalledOnce();
  });

  it("propagates a pause failure before the worker pauses and schedules no fallback", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const worker = makeYieldWorker();
    worker.pause.mockRejectedValueOnce(new Error("pause failed before pause"));
    worker.isPaused.mockReturnValue(false);

    await expect(
      yieldSyncToPortableWorker(
        async () => makeSlot(true),
        worker,
        "garmin",
        makeYieldJob(),
        "token-1",
      ),
    ).rejects.toThrow("pause failed before pause");

    expect(isPortableSyncHandoffActive(worker)).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(worker.resume).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("captures a resume rejection with the portable-sync-fallback tag", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const worker = makeYieldWorker();
    const resumeError = new Error("resume failed");
    worker.resume.mockRejectedValueOnce(resumeError);

    await expect(
      yieldSyncToPortableWorker(
        async () => makeSlot(true),
        worker,
        "tension",
        makeYieldJob(),
        "token-1",
      ),
    ).rejects.toBeInstanceOf(WaitingError);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(worker.resume).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledWith(resumeError, {
      tags: { source: "portable-sync-fallback" },
    });
  });

  it("skips resume when the worker is closing before the fallback timer fires", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const worker = makeYieldWorker();

    await expect(
      yieldSyncToPortableWorker(
        async () => makeSlot(true),
        worker,
        "tension",
        makeYieldJob(),
        "token-1",
      ),
    ).rejects.toBeInstanceOf(WaitingError);

    worker.closing = Promise.resolve();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(worker.resume).not.toHaveBeenCalled();
    expect(isPortableSyncHandoffActive(worker)).toBe(false);
  });

  it("does not mark a handoff when the reservation offer fails", async () => {
    const worker = makeYieldWorker();
    const job = makeYieldJob();

    await expect(
      yieldSyncToPortableWorker(async () => makeSlot(false), worker, "tension", job, "token-1"),
    ).resolves.toBeUndefined();

    expect(worker.pause).not.toHaveBeenCalled();
    expect(isPortableSyncHandoffActive(worker)).toBe(false);
  });

  it("does not mark a handoff when Redis reservation throws", async () => {
    const worker = makeYieldWorker();
    const redisError = new Error("reservation redis offline");
    const job = makeYieldJob();

    await expect(
      yieldSyncToPortableWorker(
        async () => makeSlot(redisError),
        worker,
        "tension",
        job,
        "token-1",
      ),
    ).resolves.toBeUndefined();

    expect(captureException).toHaveBeenCalledWith(redisError, {
      tags: { source: "portable-sync-reservation", provider: "tension" },
    });
    expect(isPortableSyncHandoffActive(worker)).toBe(false);
  });
});
