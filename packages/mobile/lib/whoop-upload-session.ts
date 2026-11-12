import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import {
  configureUpload as configureNativeWhoopUploads,
  disableUploads as disableNativeWhoopUploads,
  purgeAccountState as purgeNativeWhoopAccountState,
  type WhoopUploadContext,
} from "../modules/whoop-ble";
import { readSecureStoreItem, writeSecureStoreItem } from "./secure-store-access";

const WHOOP_CLEANUP_INTENT_KEY = "dofek_whoop_cleanup_intent_v1";
let liveCleanupIntentId: string | null = null;
let uploadConfigurationGeneration = 0;
let cleanupIntentTail: Promise<void> = Promise.resolve();
let cleanupRecovery: Promise<void> | null = null;

/** Keep intent comparison/deletion atomic with respect to a replacement intent. */
function serializeCleanupIntent<T>(operation: () => Promise<T>): Promise<T> {
  const result = cleanupIntentTail.then(operation, operation);
  cleanupIntentTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Persist one opaque cleanup fence before credentials can be replaced. */
export async function persistWhoopCleanupIntent(): Promise<string> {
  const cleanupIntentId = Crypto.randomUUID();
  await serializeCleanupIntent(async () => {
    await writeSecureStoreItem(WHOOP_CLEANUP_INTENT_KEY, cleanupIntentId);
    liveCleanupIntentId = cleanupIntentId;
  });
  return cleanupIntentId;
}

/** Clear only the durable fence owned by the cleanup that just completed. */
export async function clearWhoopCleanupIntent(cleanupIntentId: string): Promise<void> {
  await serializeCleanupIntent(async () => {
    const storedIntentId = await readSecureStoreItem(WHOOP_CLEANUP_INTENT_KEY);
    if (storedIntentId !== cleanupIntentId) return;

    await SecureStore.deleteItemAsync(WHOOP_CLEANUP_INTENT_KEY);
    if (liveCleanupIntentId === cleanupIntentId) liveCleanupIntentId = null;
  });
}

/** Resume interrupted cleanup only within asynchronous WHOOP initialization. */
async function requireWhoopCleanupToBeResolved(generation: number): Promise<void> {
  const knownIntentAtReadStart = liveCleanupIntentId;
  const storedIntentId = await serializeCleanupIntent(() =>
    readSecureStoreItem(WHOOP_CLEANUP_INTENT_KEY),
  );
  if (
    generation !== uploadConfigurationGeneration ||
    storedIntentId === null ||
    storedIntentId === knownIntentAtReadStart ||
    storedIntentId === liveCleanupIntentId
  ) {
    return;
  }

  // Share one attempt, including failure, until an explicit cleanup or restart.
  // Never put this wait in auth persistence or the app's startup gate.
  cleanupRecovery ??= disableNativeWhoopUploads().then(() =>
    clearWhoopCleanupIntent(storedIntentId),
  );
  await cleanupRecovery;
}

/** Configure account-bound native uploads after enforcing the app cleanup fence. */
export async function configureWhoopUploads(context: WhoopUploadContext): Promise<void> {
  const generation = ++uploadConfigurationGeneration;
  await requireWhoopCleanupToBeResolved(generation);
  if (generation !== uploadConfigurationGeneration) {
    throw new Error(
      "WHOOP upload configuration was superseded by a newer session or account cleanup.",
    );
  }
  await configureNativeWhoopUploads(context);
}

/** Revoke app upload ownership and await the native cleanup operation. */
export async function disableWhoopUploads(): Promise<void> {
  uploadConfigurationGeneration += 1;
  await disableNativeWhoopUploads();
}

/** Purge WHOOP account data through the app's configuration dispatch fence. */
export async function purgeWhoopAccountState(deviceErasureCutoff: string): Promise<boolean> {
  uploadConfigurationGeneration += 1;
  return purgeNativeWhoopAccountState(deviceErasureCutoff);
}
