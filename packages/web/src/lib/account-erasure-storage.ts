import {
  type AccountErasureAttemptedPreparationCapability,
  type AccountErasurePreparationCapability,
  AccountErasurePreparationCapabilitySchema,
  type AccountErasureStatusCapability,
  AccountErasureStatusCapabilitySchema,
  type AccountErasureUnattemptedPreparationCapability,
} from "@dofek/auth/account-erasure";
import { captureException } from "./telemetry.ts";

export const ACCOUNT_ERASURE_PREPARATION_STORAGE_KEY = "dofek:account-erasure:preparation:v1";
export const ACCOUNT_ERASURE_STATUS_STORAGE_KEY = "dofek:account-erasure:status:v1";
export const ACCOUNT_ERASURE_LOCAL_CLEANUP_ACK_STORAGE_KEY =
  "dofek:account-erasure:local-cleanup-ack:v1";

type AccountErasureStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

function reportStorageFailure(source: string): void {
  captureException(new Error("Account erasure browser storage operation failed."), { source });
}

function parseStoredValue<T>(
  storage: AccountErasureStorage,
  key: string,
  parse: (value: unknown) => { success: boolean; data?: T },
): T | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    reportStorageFailure("account-erasure-capability-read");
    return null;
  }
  if (raw === null) return null;

  try {
    const result = parse(JSON.parse(raw));
    if (result.success && result.data !== undefined) {
      return result.data;
    }
  } catch {
    reportStorageFailure("account-erasure-capability-parse");
  }

  try {
    storage.removeItem(key);
  } catch {
    reportStorageFailure("account-erasure-capability-remove");
  }
  return null;
}

export function loadAccountErasurePreparation(
  ownerUserId: string,
  storage: AccountErasureStorage = window.localStorage,
): AccountErasureUnattemptedPreparationCapability | null {
  const capability = parseStoredValue(storage, ACCOUNT_ERASURE_PREPARATION_STORAGE_KEY, (value) =>
    AccountErasurePreparationCapabilitySchema.safeParse(value),
  );
  return capability && "ownerUserId" in capability && capability.ownerUserId === ownerUserId
    ? capability
    : null;
}

export function saveAccountErasurePreparation(
  capability: AccountErasurePreparationCapability,
  storage: AccountErasureStorage = window.localStorage,
): void {
  try {
    storage.setItem(
      ACCOUNT_ERASURE_PREPARATION_STORAGE_KEY,
      JSON.stringify(AccountErasurePreparationCapabilitySchema.parse(capability)),
    );
  } catch {
    reportStorageFailure("account-erasure-preparation-write");
    throw new Error("Account erasure browser storage write failed.");
  }
}

export function clearAccountErasurePreparation(
  storage: AccountErasureStorage = window.localStorage,
): void {
  try {
    storage.removeItem(ACCOUNT_ERASURE_PREPARATION_STORAGE_KEY);
  } catch {
    reportStorageFailure("account-erasure-preparation-remove");
  }
}

export function loadAnyAccountErasurePreparation(
  storage: AccountErasureStorage = window.localStorage,
): AccountErasurePreparationCapability | null {
  return parseStoredValue(storage, ACCOUNT_ERASURE_PREPARATION_STORAGE_KEY, (value) =>
    AccountErasurePreparationCapabilitySchema.safeParse(value),
  );
}

export function markAccountErasureConfirmationAttempted(
  cleanupOwnerNonce: string,
  attemptedAt = new Date().toISOString(),
  storage: AccountErasureStorage = window.localStorage,
): AccountErasureAttemptedPreparationCapability {
  const preparation = loadAnyAccountErasurePreparation(storage);
  if (!preparation || !("ownerUserId" in preparation)) {
    throw new Error("The saved account deletion preparation is unavailable or invalid.");
  }
  const updated = {
    cleanupOwnerNonce,
    confirmationAttemptedAt: attemptedAt,
    expiresAt: preparation.expiresAt,
    preparationToken: preparation.preparationToken,
  };
  saveAccountErasurePreparation(updated, storage);
  return updated;
}

export function loadAccountErasureStatusCapability(
  storage: AccountErasureStorage = window.localStorage,
): AccountErasureStatusCapability | null {
  return parseStoredValue(storage, ACCOUNT_ERASURE_STATUS_STORAGE_KEY, (value) =>
    AccountErasureStatusCapabilitySchema.safeParse(value),
  );
}

export function saveAccountErasureStatusCapability(
  capability: AccountErasureStatusCapability,
  storage: AccountErasureStorage = window.localStorage,
): void {
  try {
    storage.setItem(
      ACCOUNT_ERASURE_STATUS_STORAGE_KEY,
      JSON.stringify(AccountErasureStatusCapabilitySchema.parse(capability)),
    );
  } catch {
    reportStorageFailure("account-erasure-status-write");
    throw new Error("Account erasure browser storage write failed.");
  }
}

export function clearAccountErasureStatusCapability(
  storage: AccountErasureStorage = window.localStorage,
): void {
  try {
    storage.removeItem(ACCOUNT_ERASURE_STATUS_STORAGE_KEY);
  } catch {
    reportStorageFailure("account-erasure-status-remove");
  }
}
