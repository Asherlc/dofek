// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { Alert } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureException } from "./telemetry";
import type { WhoopBleSyncDeps, WhoopUploadContext } from "./whoop-ble-sync-types";
import { makeMockDeps } from "./whoop-ble-test-helpers";

const { mockInit, mockTeardown } = vi.hoisted(() => ({
  mockInit: vi.fn().mockResolvedValue(undefined),
  mockTeardown: vi.fn(),
}));

vi.mock("./telemetry", () => ({ captureException: vi.fn() }));

vi.mock("./background-whoop-ble-sync", () => ({
  initBackgroundWhoopBleSync: (...args: unknown[]) => mockInit(...args),
  teardownBackgroundWhoopBleSync: () => mockTeardown(),
}));

describe("useWhoopBleSync", () => {
  let context: WhoopUploadContext;
  let whoopDeps: WhoopBleSyncDeps;

  beforeEach(() => {
    mockInit.mockClear().mockResolvedValue(undefined);
    mockTeardown.mockClear();
    context = { userId: "user", token: "session", serverURL: "https://example.com", headers: {} };
    whoopDeps = makeMockDeps();
  });

  it("starts sync immediately on mount", async () => {
    const { useWhoopBleSync } = await import("./useWhoopBleSync");

    renderHook(() => useWhoopBleSync(context, whoopDeps));

    expect(mockInit).toHaveBeenCalledWith(context, whoopDeps);
  });

  it("shows the specific startup error once through the capture-stop UI", async () => {
    const error = new Error("WHOOP storage could not open. Free device storage and reopen Dofek.");
    mockInit.mockRejectedValueOnce(error);
    vi.mocked(Alert.alert).mockClear();
    vi.mocked(captureException).mockClear();
    const { useWhoopBleSync } = await import("./useWhoopBleSync");
    renderHook(() => useWhoopBleSync(context, whoopDeps));
    await waitFor(() =>
      expect(Alert.alert).toHaveBeenCalledWith("WHOOP capture stopped", error.message),
    );
    expect(Alert.alert).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledExactlyOnceWith(error, {
      source: "whoop-ble-sync-init",
    });
  });

  it("reports a retired startup failure without alerting a replacement session", async () => {
    let rejectStartup!: (error: Error) => void;
    mockInit.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectStartup = reject;
      }),
    );
    vi.mocked(Alert.alert).mockClear();
    vi.mocked(captureException).mockClear();
    const { useWhoopBleSync } = await import("./useWhoopBleSync");
    const { unmount } = renderHook(() => useWhoopBleSync(context, whoopDeps));
    unmount();
    const error = new Error("old queue unavailable");
    rejectStartup(error);
    await waitFor(() =>
      expect(captureException).toHaveBeenCalledWith(error, {
        source: "whoop-ble-sync-init",
        retiredLifetime: true,
      }),
    );
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("tears down on unmount", async () => {
    const { useWhoopBleSync } = await import("./useWhoopBleSync");

    const { unmount } = renderHook(() => useWhoopBleSync(context, whoopDeps));

    mockTeardown.mockClear();
    unmount();

    expect(mockTeardown).toHaveBeenCalled();
  });
});
