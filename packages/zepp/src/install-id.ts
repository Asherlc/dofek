import { STORAGE_KEYS } from "./storage-keys.ts";

interface InstallIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function ensureInstallId(
  storage: InstallIdStorage,
  now = Date.now(),
  random = Math.random,
): string {
  const existing = storage.getItem(STORAGE_KEYS.TELEMETRY_INSTALL_ID)?.trim();
  if (existing) {
    return existing;
  }
  const installId = `${now}-${random().toString(36).slice(2, 10)}`;
  storage.setItem(STORAGE_KEYS.TELEMETRY_INSTALL_ID, installId);
  return installId;
}
