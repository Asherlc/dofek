// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InertialMeasurementUnitUploadClient } from "./inertial-measurement-unit-service";
import type { WhoopBleSyncDeps } from "./background-whoop-ble-sync";

// --- Hoisted mocks (vi.mock factories are hoisted, so refs must be too) ---

const { mockInit, mockTeardown, mockSettingState } = vi.hoisted(() => {
  const state: { value: boolean | null } = { value: null };
  return {
    mockInit: vi.fn().mockResolvedValue(undefined),
    mockTeardown: vi.fn(),
    mockSettingState: state,
  };
});

vi.mock("./trpc", () => ({
  trpc: {
    settings: {
      get: {
        useQuery: () => ({
          data: mockSettingState.value !== null ? { value: mockSettingState.value } : undefined,
          isLoading: mockSettingState.value === null,
        }),
      },
    },
  },
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
    mockSettingState.value = null;
    mockInit.mockClear().mockResolvedValue(undefined);
    mockTeardown.mockClear();
    uploadClient = makeMockUploadClient();
    whoopDeps = makeMockDeps();
  });

  it("does not start sync while setting is loading", async () => {
    const { useWhoopBleSync } = await import("./useWhoopBleSync");
    mockSettingState.value = null; // loading state

    renderHook(() => useWhoopBleSync(uploadClient, whoopDeps));

    expect(mockInit).not.toHaveBeenCalled();
  });

  it("starts sync when setting is enabled", async () => {
    const { useWhoopBleSync } = await import("./useWhoopBleSync");
    mockSettingState.value = true;

    renderHook(() => useWhoopBleSync(uploadClient, whoopDeps));

    expect(mockInit).toHaveBeenCalledWith(uploadClient, whoopDeps);
  });

  it("tears down sync when setting is disabled", async () => {
    const { useWhoopBleSync } = await import("./useWhoopBleSync");
    mockSettingState.value = false;

    renderHook(() => useWhoopBleSync(uploadClient, whoopDeps));

    expect(mockTeardown).toHaveBeenCalled();
    expect(mockInit).not.toHaveBeenCalled();
  });

  it("starts sync when setting changes from disabled to enabled", async () => {
    const { useWhoopBleSync } = await import("./useWhoopBleSync");
    mockSettingState.value = false;

    const { rerender } = renderHook(() => useWhoopBleSync(uploadClient, whoopDeps));

    expect(mockInit).not.toHaveBeenCalled();

    // Simulate setting change
    mockSettingState.value = true;
    rerender();

    expect(mockInit).toHaveBeenCalledWith(uploadClient, whoopDeps);
  });

  it("tears down sync when setting changes from enabled to disabled", async () => {
    const { useWhoopBleSync } = await import("./useWhoopBleSync");
    mockSettingState.value = true;

    const { rerender } = renderHook(() => useWhoopBleSync(uploadClient, whoopDeps));

    mockTeardown.mockClear();
    mockSettingState.value = false;
    rerender();

    expect(mockTeardown).toHaveBeenCalled();
  });

  it("tears down on unmount when enabled", async () => {
    const { useWhoopBleSync } = await import("./useWhoopBleSync");
    mockSettingState.value = true;

    const { unmount } = renderHook(() => useWhoopBleSync(uploadClient, whoopDeps));

    mockTeardown.mockClear();
    unmount();

    expect(mockTeardown).toHaveBeenCalled();
  });
});
