// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WhoopBleSyncDeps, WhoopUploadContext } from "./whoop-ble-sync-types";
import { makeMockDeps } from "./whoop-ble-test-helpers";

const { mockInit, mockTeardown } = vi.hoisted(() => ({
  mockInit: vi.fn().mockResolvedValue(undefined),
  mockTeardown: vi.fn(),
}));

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

  it("tears down on unmount", async () => {
    const { useWhoopBleSync } = await import("./useWhoopBleSync");

    const { unmount } = renderHook(() => useWhoopBleSync(context, whoopDeps));

    mockTeardown.mockClear();
    unmount();

    expect(mockTeardown).toHaveBeenCalled();
  });
});
