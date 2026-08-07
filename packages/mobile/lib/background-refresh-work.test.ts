import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("./telemetry", () => ({
  captureException: mockCaptureException,
}));

import { runRequiredBackgroundRefreshWork } from "./background-refresh-work";

describe("runRequiredBackgroundRefreshWork", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves when every required operation succeeds", async () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());

    await expect(
      runRequiredBackgroundRefreshWork([
        { source: "first-sync", run: first },
        { source: "second-sync", run: second },
      ]),
    ).resolves.toBeUndefined();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("waits for every operation to settle before rejecting", async () => {
    let resolveSecond: (() => void) | undefined;
    const firstFailure = new Error("first failed");
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    let settled = false;

    const work = runRequiredBackgroundRefreshWork([
      { source: "first-sync", run: () => Promise.reject(firstFailure) },
      { source: "second-sync", run: () => second },
    ]).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveSecond?.();
    await expect(work).rejects.toThrow("Background refresh failed");
    expect(mockCaptureException).toHaveBeenCalledWith(firstFailure, {
      source: "first-sync",
    });
  });

  it("captures every failed operation with its source", async () => {
    const firstFailure = new Error("first failed");
    const secondFailure = new Error("second failed");

    await expect(
      runRequiredBackgroundRefreshWork([
        { source: "first-sync", run: () => Promise.reject(firstFailure) },
        { source: "second-sync", run: () => Promise.reject(secondFailure) },
      ]),
    ).rejects.toThrow("Background refresh failed");

    expect(mockCaptureException).toHaveBeenNthCalledWith(1, firstFailure, {
      source: "first-sync",
    });
    expect(mockCaptureException).toHaveBeenNthCalledWith(2, secondFailure, {
      source: "second-sync",
    });
  });

  it("settles remaining operations after a synchronous failure", async () => {
    const failure = new Error("failed before returning a promise");
    const second = vi.fn(() => Promise.resolve());

    await expect(
      runRequiredBackgroundRefreshWork([
        {
          source: "first-sync",
          run: () => {
            throw failure;
          },
        },
        { source: "second-sync", run: second },
      ]),
    ).rejects.toThrow("Background refresh failed");

    expect(second).toHaveBeenCalledOnce();
    expect(mockCaptureException).toHaveBeenCalledWith(failure, {
      source: "first-sync",
    });
  });
});
