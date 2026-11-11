import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { readSecureStoreItem, writeSecureStoreItem } from "./secure-store-access";

const WHOOP_CLEANUP_INTENT_KEY = "dofek_whoop_cleanup_intent_v1";
let liveCleanupIntentId: string | null = null;

/** Persist one opaque cleanup fence before credentials can be replaced. */
export async function persistWhoopCleanupIntent(): Promise<string> {
  const cleanupIntentId = Crypto.randomUUID();
  await writeSecureStoreItem(WHOOP_CLEANUP_INTENT_KEY, cleanupIntentId);
  liveCleanupIntentId = cleanupIntentId;
  return cleanupIntentId;
}

/** Clear only the durable fence owned by the cleanup that just completed. */
export async function clearWhoopCleanupIntent(cleanupIntentId: string): Promise<void> {
  const storedIntentId = await readSecureStoreItem(WHOOP_CLEANUP_INTENT_KEY);
  if (storedIntentId !== cleanupIntentId) return;

  await SecureStore.deleteItemAsync(WHOOP_CLEANUP_INTENT_KEY);
  if (liveCleanupIntentId === cleanupIntentId) liveCleanupIntentId = null;
}

/** Reject WHOOP configuration for unknown or unreadable persisted cleanup. */
export async function requireWhoopCleanupToBeResolved(): Promise<void> {
  const knownIntentAtReadStart = liveCleanupIntentId;
  const storedIntentId = await readSecureStoreItem(WHOOP_CLEANUP_INTENT_KEY);
  if (
    storedIntentId === null ||
    storedIntentId === knownIntentAtReadStart ||
    storedIntentId === liveCleanupIntentId
  ) {
    return;
  }

  throw new Error(
    "WHOOP upload setup is blocked by pending sensor cleanup. Sign out and sign in again after cleanup finishes.",
  );
}
