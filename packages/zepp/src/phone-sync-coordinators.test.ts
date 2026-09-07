import { afterEach, describe, expect, it, vi } from "vitest";
import { persistImuConnectionBinding } from "./imu-connection-storage.ts";
import { createImuChunkEnvelope } from "./imu-upload.ts";
import { persistImuEnvelope, quarantinePhoneImuOutboxEntry } from "./phone-imu-outbox.ts";
import {
  createPhoneHealthSyncCoordinator,
  createPhoneImuSyncCoordinator,
} from "./phone-sync-coordinators.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";
import { createSettingsStorage } from "./test-helpers.ts";

afterEach(() => vi.useRealTimers());

describe("phone sync coordinators", () => {
  it("records a successful health drain", async () => {
    const storage = createSettingsStorage();
    const setStatus = vi.fn();
    const coordinator = createPhoneHealthSyncCoordinator({
      getStorage: () => storage,
      setStatus,
      report: vi.fn(),
      post: vi.fn(),
      retryBaseDelayMs: 1_000,
      maxRetryAttempts: 1,
    });

    await coordinator.requestDrain("startup");

    expect(setStatus).toHaveBeenNthCalledWith(1, { state: "syncing", reasons: ["startup"] });
    expect(setStatus).toHaveBeenLastCalledWith({ state: "done", uploaded: 0, quarantined: 0 });
    expect(storage.persisted.has(STORAGE_KEYS.LAST_HEALTH_SYNC)).toBe(true);
  });

  it("surfaces unbound historical IMU without removing it", async () => {
    vi.useFakeTimers();
    const storage = createSettingsStorage();
    persistImuEnvelope(
      storage,
      createImuChunkEnvelope({
        connectionType: "zepp",
        installId: "install-1",
        destination: { serverUrl: "https://dofek.test", accountId: "account-1" },
        segmentId: "legacy",
        sessionStartMs: 1_720_000_000_000,
        sampleOffset: 0,
        accelFreqMode: 1,
        gyroFreqMode: 0,
        hasGyroscope: false,
        samples: [{ tMs: 0, sensor: "accelerometer", x: 1, y: 2, z: 3 }],
      }),
    );
    for (const [key, value] of storage.persisted) {
      if (!key.includes(":pending:")) continue;
      const entry = JSON.parse(value);
      delete entry.payload.connection;
      storage.persisted.set(key, JSON.stringify(entry));
    }
    const setStatus = vi.fn();
    const report = vi.fn();
    const coordinator = createPhoneImuSyncCoordinator({
      getStorage: () => storage,
      setStatus,
      report,
      post: vi.fn(),
      retryBaseDelayMs: 1_000,
      maxRetryAttempts: 1,
    });

    await coordinator.requestDrain("startup");

    expect(setStatus).toHaveBeenLastCalledWith({
      state: "error",
      reason: "Choose the account for retained motion recordings in Zepp settings.",
      requiresAccountBinding: true,
    });
    expect(report).toHaveBeenCalledOnce();
    expect(storage.persisted.get(STORAGE_KEYS.PHONE_IMU_OUTBOX)).toContain("legacy:0");
  });

  it("surfaces an unbound historical IMU retained only in quarantine", async () => {
    vi.useFakeTimers();
    const storage = createSettingsStorage();
    persistImuEnvelope(
      storage,
      createImuChunkEnvelope({
        connectionType: "zepp",
        installId: "install-1",
        destination: { serverUrl: "https://dofek.test", accountId: "account-1" },
        segmentId: "legacy-quarantine",
        sessionStartMs: 1_720_000_000_000,
        sampleOffset: 0,
        accelFreqMode: 1,
        gyroFreqMode: 0,
        hasGyroscope: false,
        samples: [{ tMs: 0, sensor: "accelerometer", x: 1, y: 2, z: 3 }],
      }),
    );
    quarantinePhoneImuOutboxEntry(storage, "legacy-quarantine:0", [
      { path: "connection", message: "Original account unknown" },
    ]);
    for (const [key, value] of storage.persisted) {
      if (!key.includes(":quarantine:")) continue;
      const entry = JSON.parse(value);
      delete entry.payload.connection;
      storage.persisted.set(key, JSON.stringify(entry));
    }
    persistImuConnectionBinding(storage, STORAGE_KEYS.IMU_CONNECTION_BINDING, {
      serverUrl: "https://dofek.test",
      accountId: "account-2",
    });
    const setStatus = vi.fn();
    const post = vi.fn();
    const coordinator = createPhoneImuSyncCoordinator({
      getStorage: () => storage,
      setStatus,
      report: vi.fn(),
      post,
      retryBaseDelayMs: 1_000,
      maxRetryAttempts: 1,
    });

    await coordinator.requestDrain("startup");

    expect(post).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenLastCalledWith({
      state: "error",
      reason: "Choose the account for retained motion recordings in Zepp settings.",
      requiresAccountBinding: true,
    });
  });
});
