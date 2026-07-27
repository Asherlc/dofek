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

function parseStoredValue<T>(
  storage: Storage,
  key: string,
  parse: (value: unknown) => { success: boolean; data?: T },
): T | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;

  try {
    const result = parse(JSON.parse(raw));
    if (result.success && result.data !== undefined) {
      return result.data;
    }
  } catch (error: unknown) {
    captureException(error, { source: "account-erasure-capability-read", key });
  }

  storage.removeItem(key);
  return null;
}

export function loadAccountErasurePreparation(
  ownerUserId: string,
  storage: Storage = window.localStorage,
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
  storage: Storage = window.localStorage,
): void {
  storage.setItem(
    ACCOUNT_ERASURE_PREPARATION_STORAGE_KEY,
    JSON.stringify(AccountErasurePreparationCapabilitySchema.parse(capability)),
  );
}

export function clearAccountErasurePreparation(storage: Storage = window.localStorage): void {
  storage.removeItem(ACCOUNT_ERASURE_PREPARATION_STORAGE_KEY);
}

export function loadAnyAccountErasurePreparation(
  storage: Storage = window.localStorage,
): AccountErasurePreparationCapability | null {
  return parseStoredValue(storage, ACCOUNT_ERASURE_PREPARATION_STORAGE_KEY, (value) =>
    AccountErasurePreparationCapabilitySchema.safeParse(value),
  );
}

export function markAccountErasureConfirmationAttempted(
  cleanupOwnerNonce: string,
  attemptedAt = new Date().toISOString(),
  storage: Storage = window.localStorage,
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
  storage: Storage = window.localStorage,
): AccountErasureStatusCapability | null {
  return parseStoredValue(storage, ACCOUNT_ERASURE_STATUS_STORAGE_KEY, (value) =>
    AccountErasureStatusCapabilitySchema.safeParse(value),
  );
}

export function saveAccountErasureStatusCapability(
  capability: AccountErasureStatusCapability,
  storage: Storage = window.localStorage,
): void {
  storage.setItem(
    ACCOUNT_ERASURE_STATUS_STORAGE_KEY,
    JSON.stringify(AccountErasureStatusCapabilitySchema.parse(capability)),
  );
}

export function clearAccountErasureStatusCapability(storage: Storage = window.localStorage): void {
  storage.removeItem(ACCOUNT_ERASURE_STATUS_STORAGE_KEY);
}
