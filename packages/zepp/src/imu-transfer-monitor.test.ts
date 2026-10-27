import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorImuTransfer } from "./imu-transfer-monitor.ts";
import { deferred } from "./test-helpers.ts";

afterEach(() => vi.useRealTimers());

describe("monitorImuTransfer", () => {
  it("confirms a transferred file exactly once", async () => {
    let change: ((event: { data: Record<string, unknown> }) => void) | undefined;
    const confirm = vi.fn(async () => undefined);
    const onConfirmed = vi.fn();
    const onFailed = vi.fn();
    monitorImuTransfer(
      {
        cancel: vi.fn(),
        on: (_event, callback) => {
          change = callback;
        },
      },
      { confirm, failureReason: () => null, onConfirmed, onFailed },
    );

    change?.({ data: { readyState: "transferred" } });
    await Promise.resolve();
    change?.({ data: { readyState: "transferred" } });

    expect(confirm).toHaveBeenCalledOnce();
    expect(onConfirmed).toHaveBeenCalledOnce();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("reports a classified transfer failure without canceling a settled task", () => {
    let change: ((event: { data: Record<string, unknown> }) => void) | undefined;
    const cancel = vi.fn();
    const onFailed = vi.fn();
    monitorImuTransfer(
      {
        cancel,
        on: (_event, callback) => {
          change = callback;
        },
      },
      {
        confirm: async () => undefined,
        failureReason: (data) => (data.readyState === "error" ? "transfer failed" : null),
        onConfirmed: vi.fn(),
        onFailed,
      },
    );

    change?.({ data: { readyState: "error" } });

    expect(onFailed).toHaveBeenCalledWith(new Error("transfer failed"));
    expect(cancel).not.toHaveBeenCalled();
  });

  it("reports a rejected phone confirmation", async () => {
    let change: ((event: { data: Record<string, unknown> }) => void) | undefined;
    const onFailed = vi.fn();
    monitorImuTransfer(
      {
        cancel: vi.fn(),
        on: (_event, callback) => {
          change = callback;
        },
      },
      {
        confirm: async () => Promise.reject("not persisted"),
        failureReason: () => null,
        onConfirmed: vi.fn(),
        onFailed,
      },
    );

    change?.({ data: { readyState: "transferred" } });
    await vi.waitFor(() => {
      expect(onFailed).toHaveBeenCalledWith(new Error("not persisted"));
    });
  });

  it("times out a hung confirmation and ignores its late completion", async () => {
    vi.useFakeTimers();
    let change: ((event: { data: Record<string, unknown> }) => void) | undefined;
    const confirmation = deferred();
    const onConfirmed = vi.fn();
    const onFailed = vi.fn();
    const cancel = vi.fn();
    monitorImuTransfer(
      {
        cancel,
        on: (_event, callback) => {
          change = callback;
        },
      },
      {
        confirm: () => confirmation.promise,
        failureReason: () => null,
        onConfirmed,
        onFailed,
        timeoutMs: 100,
      },
    );

    change?.({ data: { readyState: "transferred" } });
    await vi.advanceTimersByTimeAsync(100);
    expect(cancel).toHaveBeenCalledOnce();
    expect(onFailed).toHaveBeenCalledWith(new Error("IMU file transfer timed out."));
    confirmation.resolve();
    await Promise.resolve();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("can be canceled without allowing late callbacks to mutate state", () => {
    vi.useFakeTimers();
    let change: ((event: { data: Record<string, unknown> }) => void) | undefined;
    const onConfirmed = vi.fn();
    const onFailed = vi.fn();
    const cancel = vi.fn();
    const monitor = monitorImuTransfer(
      {
        cancel,
        on: (_event, callback) => {
          change = callback;
        },
      },
      {
        confirm: async () => undefined,
        failureReason: () => "failed",
        onConfirmed,
        onFailed,
      },
    );

    monitor.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    change?.({ data: { readyState: "error" } });
    vi.runAllTimers();
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("reports an underlying transfer cancellation failure", () => {
    const cancellationError = new Error("cancel failed");
    const onFailed = vi.fn();
    const monitor = monitorImuTransfer(
      {
        cancel: () => {
          throw cancellationError;
        },
        on: vi.fn(),
      },
      {
        confirm: async () => undefined,
        failureReason: () => null,
        onConfirmed: vi.fn(),
        onFailed,
      },
    );

    monitor.cancel();

    expect(onFailed).toHaveBeenCalledWith(cancellationError);
  });
});
