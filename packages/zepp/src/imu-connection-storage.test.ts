import { describe, expect, it, vi } from "vitest";
import {
  applyWatchStartPreferences,
  persistVerifiedImuConnection,
  restoreWatchImuConnection,
  updateWatchImuConnection,
} from "./imu-connection-storage.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";
import { createSettingsStorage } from "./test-helpers.ts";

const binding = { serverUrl: "https://dofek.test/", accountId: "account-1" };

describe("IMU connection storage", () => {
  it("stores a verified account before its replaceable bearer token", () => {
    const storage = createSettingsStorage();

    persistVerifiedImuConnection(storage, "fresh-token", binding);

    expect(storage.setItem.mock.calls).toEqual([
      [
        STORAGE_KEYS.IMU_CONNECTION_BINDING,
        JSON.stringify({ serverUrl: "https://dofek.test", accountId: "account-1" }),
      ],
      [STORAGE_KEYS.DOFEK_API_TOKEN, "fresh-token"],
    ]);
  });

  it("updates the watch cache only from verified preferences", () => {
    const storage = createSettingsStorage();

    expect(
      updateWatchImuConnection(storage, {
        hasCredentials: true,
        imuConnection: binding,
      }),
    ).toEqual({ serverUrl: "https://dofek.test", accountId: "account-1" });
    expect(updateWatchImuConnection(storage, { hasCredentials: false })).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEYS.IMU_CONNECTION_BINDING);
  });

  it("reports and clears a corrupt watch cache", () => {
    const storage = createSettingsStorage({ [STORAGE_KEYS.IMU_CONNECTION_BINDING]: "{" });
    const onError = vi.fn();

    expect(restoreWatchImuConnection(storage, onError)).toBeNull();

    expect(onError).toHaveBeenCalledOnce();
    expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEYS.IMU_CONNECTION_BINDING);
  });

  it("applies a phone start command without clearing a watch-only cached binding", () => {
    const storage = createSettingsStorage();
    const state = {
      freqModeIndex: 1,
      imuConnection: { serverUrl: "https://old.test", accountId: "old-account" },
    };

    applyWatchStartPreferences(storage, state, { freqModeIndex: 2 });
    expect(state).toEqual({
      freqModeIndex: 2,
      imuConnection: { serverUrl: "https://old.test", accountId: "old-account" },
    });

    applyWatchStartPreferences(storage, state, {
      freqModeIndex: 0,
      hasCredentials: true,
      imuConnection: binding,
    });
    expect(state).toEqual({
      freqModeIndex: 0,
      imuConnection: { serverUrl: "https://dofek.test", accountId: "account-1" },
    });
  });
});
