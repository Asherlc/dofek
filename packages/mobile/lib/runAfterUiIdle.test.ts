// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const { runAfterUiIdle } = await import("./runAfterUiIdle");

describe("runAfterUiIdle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses requestIdleCallback when available", () => {
    const task = vi.fn();
    const cancelIdleCallback = vi.fn();
    const requestIdleCallback = vi.fn((_task: IdleRequestCallback, _options?: IdleRequestOptions) => {
      _task({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline);
      return 42;
    });

    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);

    const handle = runAfterUiIdle(task);

    expect(requestIdleCallback).toHaveBeenCalledWith(task, { timeout: 2_000 });
    expect(task).toHaveBeenCalledOnce();

    handle.cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(42);
  });

  it("falls back to setTimeout when requestIdleCallback is unavailable", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);

    const task = vi.fn();
    runAfterUiIdle(task);

    expect(task).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(task).toHaveBeenCalledOnce();
  });
});
