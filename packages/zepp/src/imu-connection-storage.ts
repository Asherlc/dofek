import { type ImuConnectionBinding, parseImuConnectionBinding } from "./imu-upload.ts";
import type { SettingsStorage } from "./phone-health-outbox.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readImuConnectionBinding(
  storage: SettingsStorage,
  key: string = STORAGE_KEYS.IMU_CONNECTION_BINDING,
): ImuConnectionBinding | null {
  const serialized = storage.getItem(key)?.trim();
  if (!serialized) return null;
  return parseImuConnectionBinding(JSON.parse(serialized));
}

export function persistImuConnectionBinding(
  storage: SettingsStorage,
  key: string,
  binding: ImuConnectionBinding,
): void {
  storage.setItem(key, JSON.stringify(parseImuConnectionBinding(binding)));
}

export function persistVerifiedImuConnection(
  storage: SettingsStorage,
  token: string,
  binding: ImuConnectionBinding,
): void {
  persistImuConnectionBinding(storage, STORAGE_KEYS.IMU_CONNECTION_BINDING, binding);
  storage.setItem(STORAGE_KEYS.DOFEK_API_TOKEN, token);
}

export function restoreWatchImuConnection(
  storage: SettingsStorage,
  onError: (error: unknown) => void,
): ImuConnectionBinding | null {
  try {
    return readImuConnectionBinding(storage);
  } catch (error) {
    onError(error);
    storage.removeItem(STORAGE_KEYS.IMU_CONNECTION_BINDING);
    return null;
  }
}

export function updateWatchImuConnection(
  storage: SettingsStorage,
  preferences: unknown,
): ImuConnectionBinding | null {
  if (!isRecord(preferences) || preferences.hasCredentials !== true) {
    storage.removeItem(STORAGE_KEYS.IMU_CONNECTION_BINDING);
    return null;
  }
  if (preferences.imuConnection === null) {
    storage.removeItem(STORAGE_KEYS.IMU_CONNECTION_BINDING);
    return null;
  }
  const binding = parseImuConnectionBinding(preferences.imuConnection);
  persistImuConnectionBinding(storage, STORAGE_KEYS.IMU_CONNECTION_BINDING, binding);
  return binding;
}

export function applyWatchStartPreferences(
  storage: SettingsStorage,
  state: { freqModeIndex: number; imuConnection: ImuConnectionBinding | null },
  preferences: Record<string, unknown> | undefined,
): void {
  state.freqModeIndex = Number(preferences?.freqModeIndex ?? state.freqModeIndex);
  if (preferences && "hasCredentials" in preferences) {
    state.imuConnection = updateWatchImuConnection(storage, preferences);
  }
}
