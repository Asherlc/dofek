import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModule = vi.hoisted(() => ({
  addListener: vi.fn(),
  completeRefresh: vi.fn(),
  recordRefreshReceived: vi.fn(),
  getDiagnostics: vi.fn(),
  clearDiagnostics: vi.fn(),
  isAvailable: vi.fn(),
  scheduleRefresh: vi.fn(),
}));

vi.mock("expo", () => ({
  requireNativeModule: () => nativeModule,
}));

vi.mock("../../lib/telemetry", () => ({
  captureException: vi.fn(),
  captureTelemetrySessionGuard: vi.fn(() => () => true),
  logger: { info: vi.fn() },
}));

vi.unmock("./index");

import { captureException, captureTelemetrySessionGuard } from "../../lib/telemetry";
import { addBackgroundRefreshListener, clearDiagnostics, getDiagnostics } from "./index";

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
    addBackgroundRefreshListener(handler, vi.fn());

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
    addBackgroundRefreshListener(() => Promise.reject(failure), vi.fn());

    emitRefresh({ taskId: "task-failure" });

    await vi.waitFor(() => {
      expect(nativeModule.completeRefresh).toHaveBeenCalledWith("task-failure", false);
    });
  });

  it("records receipt before work and reports settlement after native completion", async () => {
    const order: string[] = [];
    nativeModule.recordRefreshReceived.mockImplementation(() => order.push("native-received"));
    nativeModule.completeRefresh.mockImplementation(() => order.push("native-completed"));
    const boundary = vi.fn((trigger: string) => order.push(trigger));
    addBackgroundRefreshListener(async () => {
      order.push("work");
    }, boundary);
    emitRefresh({ taskId: "task-1" });
    await vi.waitFor(() => expect(boundary).toHaveBeenCalledWith("settled"));
    expect(order).toEqual(["native-received", "received", "work", "native-completed", "settled"]);
    expect(nativeModule.recordRefreshReceived).toHaveBeenCalledWith("task-1");
  });

  it("preserves handler failure and reports its settled boundary", async () => {
    const boundary = vi.fn();
    addBackgroundRefreshListener(() => Promise.reject(new Error("work failed")), boundary);
    emitRefresh({ taskId: "task-1" });
    await vi.waitFor(() => expect(boundary).toHaveBeenCalledWith("settled"));
    expect(nativeModule.completeRefresh).toHaveBeenCalledWith("task-1", false);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "background-refresh-handler" }),
    );
  });

  it("reports bridge receipt failures without skipping work or native completion", async () => {
    nativeModule.recordRefreshReceived.mockImplementationOnce(() => {
      throw new Error("bridge failed");
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    addBackgroundRefreshListener(handler, vi.fn());
    emitRefresh({ taskId: "task-1" });
    await vi.waitFor(() =>
      expect(nativeModule.completeRefresh).toHaveBeenCalledWith("task-1", true),
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: "background-refresh-received" }),
    );
  });

  it("reports late handler failures without borrowing a later account identity", async () => {
    let currentSession = true;
    vi.mocked(captureTelemetrySessionGuard).mockReturnValueOnce(() => currentSession);
    let rejectHandler: ((error: Error) => void) | undefined;
    addBackgroundRefreshListener(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectHandler = reject;
        }),
      vi.fn(),
    );
    emitRefresh({ taskId: "retired-task" });
    await vi.waitFor(() => expect(rejectHandler).toBeDefined());
    currentSession = false;
    rejectHandler?.(new Error("old work failed"));
    await vi.waitFor(() =>
      expect(nativeModule.completeRefresh).toHaveBeenCalledWith("retired-task", false),
    );
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      source: "background-refresh-handler",
      retiredLifetime: true,
    });
  });

  it("exposes nondestructive native reads and explicit clearing", () => {
    const payload = { events: [], overflowCount: 2 };
    nativeModule.getDiagnostics.mockReturnValue(payload);
    expect(getDiagnostics()).toBe(payload);
    expect(getDiagnostics()).toBe(payload);
    clearDiagnostics();
    expect(nativeModule.clearDiagnostics).toHaveBeenCalledOnce();
  });

  it("returns the native event subscription", () => {
    const result = addBackgroundRefreshListener(() => Promise.resolve(), vi.fn());

    expect(result).toBe(subscription);
  });
});
