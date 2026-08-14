// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  BleHeartRateSyncDeps,
  BleHeartRateUploadClient,
} from "./background-ble-heart-rate-sync";

const { mockInit, mockTeardown } = vi.hoisted(() => ({
  mockInit: vi.fn().mockResolvedValue(undefined),
  mockTeardown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./background-ble-heart-rate-sync", () => ({
  initBackgroundBleHeartRateSync: (...args: unknown[]) => mockInit(...args),
  teardownBackgroundBleHeartRateSync: () => mockTeardown(),
}));

vi.mock("./telemetry", () => ({
  captureException: vi.fn(),
}));

const uploadClient = {
  bleHeartRateSync: {
    pushSamples: {
      mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
    },
  },
} satisfies BleHeartRateUploadClient;

const deps = {
  isBluetoothAvailable: vi.fn().mockReturnValue(true),
  scanAndConnect: vi.fn().mockResolvedValue({ id: "polar-123", name: "Polar H10" }),
  peekBufferedSamples: vi.fn().mockResolvedValue([]),
  confirmSamplesDrain: vi.fn(),
  disconnectAndClearBufferedSamples: vi.fn().mockResolvedValue(undefined),
  addConnectionStateListener: vi.fn().mockReturnValue({ remove: vi.fn() }),
  addHeartRateListener: vi.fn().mockReturnValue({ remove: vi.fn() }),
  disconnect: vi.fn(),
} satisfies BleHeartRateSyncDeps;

describe("useBleHeartRateSync", () => {
  it("owns the authenticated BLE heart-rate lifecycle", async () => {
    const { useBleHeartRateSync } = await import("./useBleHeartRateSync");
    const { unmount } = renderHook(() => useBleHeartRateSync(uploadClient, deps));

    expect(mockInit).toHaveBeenCalledWith(uploadClient, deps);

    unmount();
    expect(mockTeardown).toHaveBeenCalledOnce();
  });
});
