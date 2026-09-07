import { afterEach, describe, expect, it, vi } from "vitest";
import { persistImuConnectionBinding } from "./imu-connection-storage.ts";
import { createImuChunkEnvelope } from "./imu-upload.ts";
import { persistImuEnvelope, quarantinePhoneImuOutboxEntry } from "./phone-imu-outbox.ts";
import type { PostImuEnvelope } from "./phone-imu-sync.ts";
import {
  createPhoneHealthSyncCoordinator,
  createPhoneImuSyncCoordinator,
} from "./phone-sync-coordinators.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";
import { createSettingsStorage } from "./test-helpers.ts";

afterEach(() => vi.useRealTimers());

describe("phone sync coordinators", () => {
  it("records a successful health drain", async () => {
    vi.useFakeTimers();
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
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a health failure and retries with the configured delay", async () => {
    vi.useFakeTimers();
    const storage = createSettingsStorage();
    const failure = new Error("health storage unavailable");
    const getStorage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValue(storage);
    const setStatus = vi.fn();
    const report = vi.fn();
    const coordinator = createPhoneHealthSyncCoordinator({
      getStorage,
      setStatus,
      report,
      post: vi.fn(),
      retryBaseDelayMs: 100,
      maxRetryAttempts: 1,
    });

    await coordinator.requestDrain("startup");

    expect(report).toHaveBeenCalledExactlyOnceWith(failure, {
      category: "health-upload",
      reasons: ["startup"],
    });
    expect(setStatus).toHaveBeenLastCalledWith({
      state: "error",
      reason: "health storage unavailable",
    });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(getStorage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(getStorage).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenLastCalledWith({ state: "done", uploaded: 0, quarantined: 0 });
  });

  it("reports an unexpected health retry failure through the retry hook", async () => {
    vi.useFakeTimers();
    const uploadFailure = new Error("health storage unavailable");
    const reportFailure = new Error("health reporting unavailable");
    const report = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw reportFailure;
      })
      .mockImplementationOnce(() => undefined);
    const coordinator = createPhoneHealthSyncCoordinator({
      getStorage: () => {
        throw uploadFailure;
      },
      setStatus: vi.fn(),
      report,
      post: vi.fn(),
      retryBaseDelayMs: 100,
      maxRetryAttempts: 1,
    });

    await coordinator.requestDrain("startup");
    await vi.advanceTimersByTimeAsync(100);

    expect(report).toHaveBeenNthCalledWith(3, reportFailure, {
      category: "health-upload-retry",
    });
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

  it("reports an IMU failure and retries with the configured delay", async () => {
    vi.useFakeTimers();
    const storage = createSettingsStorage();
    const failure = new Error("IMU storage unavailable");
    const getStorage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValue(storage);
    const setStatus = vi.fn();
    const report = vi.fn();
    const coordinator = createPhoneImuSyncCoordinator({
      getStorage,
      setStatus,
      report,
      post: vi.fn(),
      retryBaseDelayMs: 100,
      maxRetryAttempts: 1,
    });

    await coordinator.requestDrain("connection-restored");

    expect(setStatus).toHaveBeenNthCalledWith(1, {
      state: "syncing",
      reasons: ["connection-restored"],
    });
    expect(report).toHaveBeenCalledExactlyOnceWith(failure, {
      category: "imu-upload",
      reasons: ["connection-restored"],
    });
    expect(setStatus).toHaveBeenLastCalledWith({
      state: "error",
      reason: "IMU storage unavailable",
    });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(100);

    expect(getStorage).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenLastCalledWith({ state: "done", uploaded: 0, quarantined: 0 });
  });

  it("reports an unexpected IMU retry failure through the retry hook", async () => {
    vi.useFakeTimers();
    const uploadFailure = new Error("IMU storage unavailable");
    const reportFailure = new Error("IMU reporting unavailable");
    const report = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw reportFailure;
      })
      .mockImplementationOnce(() => undefined);
    const coordinator = createPhoneImuSyncCoordinator({
      getStorage: () => {
        throw uploadFailure;
      },
      setStatus: vi.fn(),
      report,
      post: vi.fn(),
      retryBaseDelayMs: 100,
      maxRetryAttempts: 1,
    });

    await coordinator.requestDrain("startup");
    await vi.advanceTimersByTimeAsync(100);

    expect(report).toHaveBeenNthCalledWith(3, reportFailure, {
      category: "imu-upload-retry",
    });
  });

  it.each([
    [1, "1 motion recording needs recovery. Contact support before deleting app data."],
    [2, "2 motion recordings need recovery. Contact support before deleting app data."],
  ])("surfaces %i newly quarantined recording(s)", async (count, reason) => {
    vi.useFakeTimers();
    const storage = createSettingsStorage();
    persistImuConnectionBinding(storage, STORAGE_KEYS.IMU_CONNECTION_BINDING, {
      serverUrl: "https://dofek.test",
      accountId: "account-1",
    });
    for (let index = 0; index < count; index += 1) {
      persistImuEnvelope(
        storage,
        createImuChunkEnvelope({
          connectionType: "zepp",
          installId: "install-1",
          destination: { serverUrl: "https://dofek.test", accountId: "account-1" },
          segmentId: `rejected-${index}`,
          sessionStartMs: 1_720_000_000_000,
          sampleOffset: 0,
          accelFreqMode: 1,
          gyroFreqMode: 0,
          hasGyroscope: false,
          samples: [{ tMs: 0, sensor: "accelerometer", x: 1, y: 2, z: 3 }],
        }),
      );
    }
    const setStatus = vi.fn();
    const coordinator = createPhoneImuSyncCoordinator({
      getStorage: () => storage,
      setStatus,
      report: vi.fn(),
      post: vi.fn(async (batch: Parameters<PostImuEnvelope>[0]) => ({
        acceptedEventIds: [],
        rejected: batch.events.map((event) => ({
          eventId: event.eventId,
          issues: [{ path: "samples.0", message: "Invalid sample" }],
        })),
      })),
      retryBaseDelayMs: 100,
      maxRetryAttempts: 1,
    });

    await coordinator.requestDrain("watch-receipt");

    expect(setStatus).toHaveBeenLastCalledWith({
      state: "error",
      uploaded: 0,
      quarantined: count,
      reason,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
