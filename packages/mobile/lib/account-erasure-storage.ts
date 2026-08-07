import {
  type AccountErasureAttemptedPreparationCapability,
  type AccountErasurePreparationCapability,
  AccountErasurePreparationCapabilitySchema,
  type AccountErasureStatusCapability,
  AccountErasureStatusCapabilitySchema,
  type AccountErasureUnattemptedPreparationCapability,
} from "@dofek/auth/account-erasure";
import {
  deleteSecureStoreItem,
  readSecureStoreItem,
  writeSecureStoreItem,
} from "./secure-store-access";
import { captureException } from "./telemetry";

export const MOBILE_ACCOUNT_ERASURE_PREPARATION_KEY = "dofek_account_erasure_preparation_v1";
export const MOBILE_ACCOUNT_ERASURE_STATUS_KEY = "dofek_account_erasure_status_v1";

async function readCapability<T>(
  key: string,
  parse: (value: unknown) => { success: boolean; data?: T },
): Promise<T | null> {
  const raw = await readSecureStoreItem(key);
  if (raw === null) return null;
  try {
    const parsed = parse(JSON.parse(raw));
    if (parsed.success && parsed.data !== undefined) return parsed.data;
  } catch (error: unknown) {
    captureException(error, { source: "account-erasure-secure-store-read", key });
  }
  await deleteSecureStoreItem(key);
  return null;
}

export function loadAnyMobileAccountErasurePreparation(): Promise<AccountErasurePreparationCapability | null> {
  return readCapability(MOBILE_ACCOUNT_ERASURE_PREPARATION_KEY, (value) =>
    AccountErasurePreparationCapabilitySchema.safeParse(value),
  );
}

export async function loadMobileAccountErasurePreparation(
  ownerUserId: string,
): Promise<AccountErasureUnattemptedPreparationCapability | null> {
  const preparation = await loadAnyMobileAccountErasurePreparation();
  return preparation && "ownerUserId" in preparation && preparation.ownerUserId === ownerUserId
    ? preparation
    : null;
}

export async function saveMobileAccountErasurePreparation(
  capability: AccountErasurePreparationCapability,
): Promise<void> {
  await writeSecureStoreItem(
    MOBILE_ACCOUNT_ERASURE_PREPARATION_KEY,
    JSON.stringify(AccountErasurePreparationCapabilitySchema.parse(capability)),
  );
}

export function clearMobileAccountErasurePreparation(): Promise<void> {
  return deleteSecureStoreItem(MOBILE_ACCOUNT_ERASURE_PREPARATION_KEY);
}

export async function markMobileAccountErasureConfirmationAttempted(
  cleanupOwnerNonce: string,
  attemptedAt = new Date().toISOString(),
): Promise<AccountErasureAttemptedPreparationCapability> {
  const preparation = await loadAnyMobileAccountErasurePreparation();
  if (!preparation || !("ownerUserId" in preparation)) {
    throw new Error("The saved account deletion preparation is unavailable or invalid.");
  }
  const updated = {
    cleanupOwnerNonce,
    confirmationAttemptedAt: attemptedAt,
    expiresAt: preparation.expiresAt,
    preparationToken: preparation.preparationToken,
  };
  await saveMobileAccountErasurePreparation(updated);
  return updated;
}

export function loadMobileAccountErasureStatusCapability(): Promise<AccountErasureStatusCapability | null> {
  return readCapability(MOBILE_ACCOUNT_ERASURE_STATUS_KEY, (value) =>
    AccountErasureStatusCapabilitySchema.safeParse(value),
  );
}

export async function saveMobileAccountErasureStatusCapability(
  capability: AccountErasureStatusCapability,
): Promise<void> {
  await writeSecureStoreItem(
    MOBILE_ACCOUNT_ERASURE_STATUS_KEY,
    JSON.stringify(AccountErasureStatusCapabilitySchema.parse(capability)),
  );
}

export function clearMobileAccountErasureStatusCapability(): Promise<void> {
  return deleteSecureStoreItem(MOBILE_ACCOUNT_ERASURE_STATUS_KEY);
}
