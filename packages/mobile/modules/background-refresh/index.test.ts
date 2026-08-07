import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModule = vi.hoisted(() => ({
  addListener: vi.fn(),
  completeRefresh: vi.fn(),
  isAvailable: vi.fn(),
  scheduleRefresh: vi.fn(),
}));

vi.mock("expo-modules-core", () => ({
  requireNativeModule: () => nativeModule,
}));

vi.unmock("./index");

import { addBackgroundRefreshListener } from "./index";

type BackgroundRefreshEvent = {
  taskId: string;
};

describe("addBackgroundRefreshListener", () => {
  let emitRefresh: (event: BackgroundRefreshEvent) => void;
  const subscription = { remove: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    nativeModule.addListener.mockImplementation(
      (_eventName: string, listener: (event: BackgroundRefreshEvent) => void) => {
        emitRefresh = listener;
        return subscription;
      },
    );
  });

  it("reports success only after the JavaScript handler resolves", async () => {
    let resolveHandler: (() => void) | undefined;
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHandler = resolve;
        }),
    );
    addBackgroundRefreshListener(handler);

    emitRefresh({ taskId: "task-success" });
    expect(nativeModule.completeRefresh).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledOnce();
    });
    resolveHandler?.();
    await vi.waitFor(() => {
      expect(nativeModule.completeRefresh).toHaveBeenCalledWith("task-success", true);
    });
  });

  it("reports failure when the JavaScript handler rejects", async () => {
    const failure = new Error("sync failed");
    addBackgroundRefreshListener(() => Promise.reject(failure));

    emitRefresh({ taskId: "task-failure" });

    await vi.waitFor(() => {
      expect(nativeModule.completeRefresh).toHaveBeenCalledWith("task-failure", false);
    });
  });

  it("returns the native event subscription", () => {
    const result = addBackgroundRefreshListener(() => Promise.resolve());

    expect(result).toBe(subscription);
  });
});
