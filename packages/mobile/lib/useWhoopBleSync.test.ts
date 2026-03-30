// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhoopBleSyncDeps } from "./background-whoop-ble-sync";
import type { InertialMeasurementUnitUploadClient } from "./inertial-measurement-unit-service";

const { mockInit, mockTeardown } = vi.hoisted(() => ({
  mockInit: vi.fn().mockResolvedValue(undefined),
  mockTeardown: vi.fn(),
}));

vi.mock("./background-whoop-ble-sync", () => ({
  initBackgroundWhoopBleSync: (...args: unknown[]) => mockInit(...args),
  teardownBackgroundWhoopBleSync: () => mockTeardown(),
}));

function makeMockDeps(): WhoopBleSyncDeps {
  return {
    isBluetoothAvailable: vi.fn().mockReturnValue(true),
    findWhoop: vi.fn().mockResolvedValue({ id: "whoop-123", name: "WHOOP 4.0" }),
    connect: vi.fn().mockResolvedValue(true),
    startImuStreaming: vi.fn().mockResolvedValue(true),
    stopImuStreaming: vi.fn().mockResolvedValue(true),
    getBufferedSamples: vi.fn().mockResolvedValue([]),
    getBufferedRealtimeData: vi.fn().mockResolvedValue([]),
    disconnect: vi.fn(),
  };
}

function makeMockUploadClient(): InertialMeasurementUnitUploadClient {
  return {
    inertialMeasurementUnitSync: {
      pushSamples: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
    },
  };
}

describe("useWhoopBleSync", () => {
  let uploadClient: InertialMeasurementUnitUploadClient;
  let whoopDeps: WhoopBleSyncDeps;

  beforeEach(() => {
    mockInit.mockClear().mockResolvedValue(undefined);
    mockTeardown.mockClear();
    uploadClient = makeMockUploadClient();
    whoopDeps = makeMockDeps();
  });

  it("starts sync immediately on mount", async () => {
    const { useWhoopBleSync } = await import("./useWhoopBleSync");

    renderHook(() => useWhoopBleSync(uploadClient, whoopDeps));

    expect(mockInit).toHaveBeenCalledWith(uploadClient, whoopDeps, undefined);
  });

  it("tears down on unmount", async () => {
    const { useWhoopBleSync } = await import("./useWhoopBleSync");

    const { unmount } = renderHook(() => useWhoopBleSync(uploadClient, whoopDeps));

    mockTeardown.mockClear();
    unmount();

    expect(mockTeardown).toHaveBeenCalled();
  });
});
