import { persistImuConnectionBinding, readImuConnectionBinding } from "./imu-connection-storage.ts";
import { parseImuEnvelope } from "./imu-upload.ts";
import type { SettingsStorage } from "./phone-health-outbox.ts";
import { assignLegacyPhoneImuOutbox, persistImuEnvelope } from "./phone-imu-outbox.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";

export function assignLegacyImuToCurrentAccount(storage: SettingsStorage): number {
  const binding = readImuConnectionBinding(storage);
  if (!binding) throw new Error("Connect and verify Dofek before assigning recordings.");
  const assigned = assignLegacyPhoneImuOutbox(storage, binding);
  persistImuConnectionBinding(storage, STORAGE_KEYS.LEGACY_IMU_RECOVERY_BINDING, binding);
  return assigned;
}

export function persistReceivedImuEnvelope(
  storage: SettingsStorage,
  value: unknown,
): { acceptedEventIds: string[] } {
  if (!storage.getItem(STORAGE_KEYS.DOFEK_API_TOKEN)?.trim()) {
    throw new Error("Connect Dofek from Zepp settings before sending IMU chunks.");
  }
  return persistImuEnvelope(
    storage,
    parseImuEnvelope(value),
    readImuConnectionBinding(storage, STORAGE_KEYS.LEGACY_IMU_RECOVERY_BINDING) ?? undefined,
  );
}
