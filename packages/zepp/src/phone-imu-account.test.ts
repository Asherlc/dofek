import { describe, expect, it } from "vitest";
import { persistImuConnectionBinding, readImuConnectionBinding } from "./imu-connection-storage.ts";
import { createImuChunkEnvelope } from "./imu-upload.ts";
import {
  assignLegacyImuToCurrentAccount,
  persistReceivedImuEnvelope,
} from "./phone-imu-account.ts";
import { readPhoneImuOutbox } from "./phone-imu-outbox.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";
import { createSettingsStorage } from "./test-helpers.ts";

function historicalEnvelope() {
  return createImuChunkEnvelope({
    connectionType: "zepp",
    installId: "install-1",
    segmentId: "legacy",
    sessionStartMs: 1_720_000_000_000,
    sampleOffset: 0,
    accelFreqMode: 1,
    gyroFreqMode: 0,
    hasGyroscope: false,
    samples: [{ tMs: 0, sensor: "accelerometer", x: 1, y: 2, z: 3 }],
  });
}

describe("phone IMU account handoff", () => {
  it("requires a verified current account before assigning historical recordings", () => {
    expect(() => assignLegacyImuToCurrentAccount(createSettingsStorage())).toThrow(
      "Connect and verify Dofek before assigning recordings",
    );
  });

  it("persists the verified account as the explicit historical-recovery choice", () => {
    const storage = createSettingsStorage();
    const binding = { serverUrl: "https://dofek.test", accountId: "account-1" };
    persistImuConnectionBinding(storage, STORAGE_KEYS.IMU_CONNECTION_BINDING, binding);

    expect(assignLegacyImuToCurrentAccount(storage)).toBe(0);
    expect(readImuConnectionBinding(storage, STORAGE_KEYS.LEGACY_IMU_RECOVERY_BINDING)).toEqual(
      binding,
    );
  });

  it("accepts a historical watch chunk only after explicit recovery assignment", () => {
    const storage = createSettingsStorage({ [STORAGE_KEYS.DOFEK_API_TOKEN]: "fresh-token" });
    const envelope = historicalEnvelope();

    expect(() => persistReceivedImuEnvelope(storage, envelope)).toThrow(
      "Choose the account for retained motion recordings",
    );
    persistImuConnectionBinding(storage, STORAGE_KEYS.LEGACY_IMU_RECOVERY_BINDING, {
      serverUrl: "https://dofek.test",
      accountId: "account-1",
    });

    expect(persistReceivedImuEnvelope(storage, envelope)).toEqual({
      acceptedEventIds: ["legacy:0"],
    });
    expect(readPhoneImuOutbox(storage).pending[0]?.payload.connection).toEqual({
      serverUrl: "https://dofek.test",
      accountId: "account-1",
    });
  });

  it("does not acknowledge a watch chunk while disconnected", () => {
    expect(() => persistReceivedImuEnvelope(createSettingsStorage(), historicalEnvelope())).toThrow(
      "Connect Dofek",
    );
  });

  it("treats a whitespace-only companion token as disconnected", () => {
    const storage = createSettingsStorage({ [STORAGE_KEYS.DOFEK_API_TOKEN]: "   " });

    expect(() => persistReceivedImuEnvelope(storage, historicalEnvelope())).toThrow(
      "Connect Dofek",
    );
    expect(readPhoneImuOutbox(storage)).toEqual({ pending: [], quarantine: [] });
  });
});
