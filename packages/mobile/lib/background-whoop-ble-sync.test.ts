import { Alert, AppState } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initBackgroundWhoopBleSync,
  syncWhoopBle,
  teardownBackgroundWhoopBleSync,
} from "./background-whoop-ble-sync";
import type { WhoopBleSyncDeps } from "./whoop-ble-sync-types";
import { makeWhoopCaptureStats } from "./whoop-ble-test-helpers";

let stateChanged: (state: string) => void;
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  AppState: {
    currentState: "active",
    addEventListener: vi.fn((_event, callback) => {
      stateChanged = callback;
      return { remove: vi.fn() };
    }),
  },
}));
const context = {
  userId: "user-1",
  serverURL: "https://example.com",
  token: "session",
  headers: { "x-app-version": "1" },
};
function deps() {
  return {
    addCaptureErrorListener: vi
      .fn<WhoopBleSyncDeps["addCaptureErrorListener"]>()
      .mockReturnValue({ remove: vi.fn() }),
    configureUpload: vi.fn(),
    flushUploads: vi.fn(),
    getDataPathStats: vi.fn(makeWhoopCaptureStats),
    findWhoop: vi.fn().mockResolvedValue({ id: "strap", name: "WHOOP" }),
    connect: vi.fn().mockResolvedValue(true),
    startImuStreaming: vi.fn().mockResolvedValue(true),
    stopImuStreaming: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn(),
    addConnectionStateListener: vi.fn().mockReturnValue({ remove: vi.fn() }),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("native WHOOP lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    AppState.currentState = "active";
  });
  afterEach(() => teardownBackgroundWhoopBleSync());
  it("configures account ownership before capture and flushes native delivery", async () => {
    const native = deps();
    await initBackgroundWhoopBleSync(context, native);
    expect(native.configureUpload).toHaveBeenCalledWith(context);
    expect(native.configureUpload.mock.invocationCallOrder[0]).toBeLessThan(
      native.connect.mock.invocationCallOrder[0] ?? 0,
    );
    expect(native.startImuStreaming).toHaveBeenCalledOnce();
    expect(native.flushUploads).toHaveBeenCalled();
  });
  it("configures and flushes in background, deferring connection until foreground", async () => {
    AppState.currentState = "background";
    const native = deps();
    await initBackgroundWhoopBleSync(context, native);
    expect(native.configureUpload).toHaveBeenCalledWith(context);
    expect(native.flushUploads).toHaveBeenCalledOnce();
    expect(native.findWhoop).not.toHaveBeenCalled();
    AppState.currentState = "active";
    stateChanged("active");
    await vi.waitFor(() => expect(native.startImuStreaming).toHaveBeenCalledOnce());
  });
  it("flushes queued uploads when no strap is available", async () => {
    const native = deps();
    native.findWhoop.mockResolvedValue(null);
    await initBackgroundWhoopBleSync(context, native);
    expect(native.flushUploads).toHaveBeenCalled();
  });
  it("background refresh flushes without requiring a connection", async () => {
    AppState.currentState = "background";
    const native = deps();
    await initBackgroundWhoopBleSync(context, native);
    native.flushUploads.mockClear();
    await syncWhoopBle();
    expect(native.flushUploads).toHaveBeenCalledOnce();
    expect(native.findWhoop).not.toHaveBeenCalled();
  });
  it("propagates configuration failure before capture starts", async () => {
    const native = deps();
    native.configureUpload.mockImplementation(() => {
      throw new Error("queue unavailable");
    });
    await expect(initBackgroundWhoopBleSync(context, native)).rejects.toThrow("queue unavailable");
    expect(native.findWhoop).not.toHaveBeenCalled();
  });
  it("removes partially installed listeners when startup fails", async () => {
    const native = deps();
    native.flushUploads.mockImplementation(() => {
      throw new Error("queue unavailable");
    });
    await expect(initBackgroundWhoopBleSync(context, native)).rejects.toThrow("queue unavailable");
    expect(native.addCaptureErrorListener.mock.results[0]?.value.remove).toHaveBeenCalledOnce();
    expect(native.addConnectionStateListener.mock.results[0]?.value.remove).toHaveBeenCalledOnce();
    expect(
      vi.mocked(AppState.addEventListener).mock.results[0]?.value.remove,
    ).toHaveBeenCalledOnce();
    native.flushUploads.mockClear();
    await syncWhoopBle();
    expect(native.flushUploads).not.toHaveBeenCalled();
  });
  it("keeps discovery single-flight across foreground reentry", async () => {
    const native = deps();
    const found = deferred<{ id: string; name: string }>();
    native.findWhoop.mockReturnValue(found.promise);
    const initializing = initBackgroundWhoopBleSync(context, native);
    AppState.currentState = "background";
    stateChanged("background");
    AppState.currentState = "active";
    stateChanged("active");
    expect(native.findWhoop).toHaveBeenCalledOnce();
    found.resolve({ id: "strap", name: "WHOOP" });
    await initializing;
    expect(native.connect).toHaveBeenCalledOnce();
    expect(native.startImuStreaming).toHaveBeenCalledOnce();
  });
  it.each(["find", "connect", "stream"])(
    "stops foreground connection work after backgrounding during %s",
    async (stage) => {
      const native = deps();
      const gate = deferred<boolean>();
      const found = deferred<{ id: string; name: string }>();
      if (stage === "find") native.findWhoop.mockReturnValueOnce(found.promise);
      if (stage === "connect") native.connect.mockReturnValueOnce(gate.promise);
      if (stage === "stream") native.startImuStreaming.mockReturnValueOnce(gate.promise);
      const initializing = initBackgroundWhoopBleSync(context, native);
      await vi.waitFor(() =>
        expect(
          stage === "find"
            ? native.findWhoop
            : stage === "connect"
              ? native.connect
              : native.startImuStreaming,
        ).toHaveBeenCalled(),
      );
      AppState.currentState = "background";
      stateChanged("background");
      if (stage === "find") found.resolve({ id: "strap", name: "WHOOP" });
      else gate.resolve(true);
      await initializing;
      if (stage === "find") expect(native.connect).not.toHaveBeenCalled();
      else expect(native.disconnect).toHaveBeenCalledOnce();
    },
  );
  it("ignores stale connection completion after a replacement session starts", async () => {
    const old = deps();
    const gate = deferred<boolean>();
    old.connect.mockReturnValue(gate.promise);
    const initializing = initBackgroundWhoopBleSync(context, old);
    await vi.waitFor(() => expect(old.connect).toHaveBeenCalled());
    const next = deps();
    await initBackgroundWhoopBleSync({ ...context, userId: "user-2" }, next);
    gate.resolve(true);
    await initializing;
    expect(old.startImuStreaming).not.toHaveBeenCalled();
    expect(old.disconnect).toHaveBeenCalledOnce();
    expect(next.startImuStreaming).toHaveBeenCalledOnce();
  });
  it("surfaces durable capture failure and removes its listener on retirement", async () => {
    const native = deps();
    await initBackgroundWhoopBleSync(context, native);
    const callback = native.addCaptureErrorListener.mock.calls[0]?.[0];
    expect(callback).toBeTypeOf("function");
    callback?.({ message: "Storage is full. Free space and reopen Dofek." });
    expect(Alert.alert).toHaveBeenCalledWith(
      "WHOOP capture stopped",
      "Storage is full. Free space and reopen Dofek.",
    );
    teardownBackgroundWhoopBleSync();
    expect(native.addCaptureErrorListener.mock.results[0]?.value.remove).toHaveBeenCalledOnce();
  });
  it("retirement disconnects BLE and removes lifecycle listeners", async () => {
    const native = deps();
    await initBackgroundWhoopBleSync(context, native);
    teardownBackgroundWhoopBleSync();
    expect(native.disconnect).toHaveBeenCalledOnce();
    expect(native.stopImuStreaming).toHaveBeenCalledOnce();
    expect(native.addConnectionStateListener.mock.results[0]?.value.remove).toHaveBeenCalledOnce();
  });
});
