import { describe, expect, it } from "vitest";
import { persistImuConnectionBinding } from "./imu-connection-storage.ts";
import { createImuChunkEnvelope } from "./imu-upload.ts";
import { persistReceivedImuEnvelope } from "./phone-imu-account.ts";
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
});
