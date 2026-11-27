import { type AuthUser, AuthUserSchema } from "@dofek/auth/auth";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { z } from "zod";
import { retireCollectionNotifications } from "../modules/background-refresh";
import {
  deleteSecureStoreItem,
  readSecureStoreItem,
  writeSecureStoreItem,
} from "./secure-store-access";
import { captureException } from "./telemetry";
import {
  clearWhoopCleanupIntent,
  disableWhoopUploads,
  persistWhoopCleanupIntent,
} from "./whoop-upload-session";

const SESSION_TOKEN_KEY = "dofek_session_token";
const SESSION_USER_KEY = "dofek_session_user_v1";
const SESSION_OWNER_NONCE_KEY = "dofek_session_owner_nonce_v1";

// In-memory cache avoids SecureStore reads while iOS has the device locked in background.
// Reads still fall back to SecureStore on cold start in the foreground.
let cachedSessionToken: string | null | undefined;
let sessionPersistenceGeneration = 0;
let sessionPersistenceTail: Promise<void> = Promise.resolve();
let sessionAdoptionFailure: unknown;
let hasSessionAdoptionFailure = false;

function serializeSessionPersistence<T>(operation: () => Promise<T>): Promise<T> {
  const result = sessionPersistenceTail.then(operation, operation);
  sessionPersistenceTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Invalidate auth persistence synchronously before account-owned cleanup begins. */
export function invalidateSessionPersistence(): void {
  sessionPersistenceGeneration += 1;
  cachedSessionToken = null;
}

/** Generate an opaque local marker without retaining an account identifier. */
export function createAccountErasureCleanupNonce(): string {
  return Crypto.randomUUID();
}

/** Save the session token to secure storage. */
export async function saveSessionToken(token: string): Promise<void> {
  const writeGeneration = sessionPersistenceGeneration;
  await serializeSessionPersistence(async () => {
    if (writeGeneration !== sessionPersistenceGeneration) return;
    if (hasSessionAdoptionFailure) throw sessionAdoptionFailure;
    const storedToken = await readSecureStoreItem(SESSION_TOKEN_KEY);
    if (writeGeneration !== sessionPersistenceGeneration) return;
    if (storedToken !== token) {
      await SecureStore.deleteItemAsync(SESSION_USER_KEY);
      if (writeGeneration !== sessionPersistenceGeneration) return;
    }
    await writeSecureStoreItem(SESSION_TOKEN_KEY, token);
    if (writeGeneration === sessionPersistenceGeneration) {
      cachedSessionToken = token;
    }
  });
}

/** Get the saved session token, or null if not logged in. */
export async function getSessionToken(): Promise<string | null> {
  const readGeneration = sessionPersistenceGeneration;
  return serializeSessionPersistence(async () => {
    if (readGeneration !== sessionPersistenceGeneration) return null;
    if (cachedSessionToken !== undefined) {
      return cachedSessionToken;
    }

    const token = await readSecureStoreItem(SESSION_TOKEN_KEY);
    if (readGeneration !== sessionPersistenceGeneration) return null;
    if (token !== null) {
      cachedSessionToken = token;
    }
    return token;
  });
}

/** Save a verified user only while their session token remains persisted. */
export async function saveSessionUser(token: string, user: AuthUser): Promise<void> {
  const writeGeneration = sessionPersistenceGeneration;
  await serializeSessionPersistence(async () => {
    if (writeGeneration !== sessionPersistenceGeneration) return;
    const storedToken = await readSecureStoreItem(SESSION_TOKEN_KEY);
    if (writeGeneration !== sessionPersistenceGeneration || storedToken !== token) return;
    await writeSecureStoreItem(SESSION_USER_KEY, JSON.stringify(AuthUserSchema.parse(user)));
    if (writeGeneration !== sessionPersistenceGeneration) {
      await SecureStore.deleteItemAsync(SESSION_USER_KEY);
    }
  });
}

/** Restore the saved user belonging to the persisted token without a network request. */
export async function getSavedSessionUser(token: string): Promise<AuthUser | null> {
  const readGeneration = sessionPersistenceGeneration;
  return serializeSessionPersistence(async () => {
    if (readGeneration !== sessionPersistenceGeneration) return null;
    const storedToken = await readSecureStoreItem(SESSION_TOKEN_KEY);
    if (readGeneration !== sessionPersistenceGeneration || storedToken !== token) return null;
    const storedUser = await readSecureStoreItem(SESSION_USER_KEY);
    if (readGeneration !== sessionPersistenceGeneration || storedUser === null) return null;
    try {
      const data: unknown = JSON.parse(storedUser);
      return AuthUserSchema.parse(data);
    } catch (error: unknown) {
      captureException(error, { source: "auth-saved-user-restore" });
      return null;
    }
  });
}

/**
 * Retry durable alert retirement after a confirmed signed-out bootstrap.
 * Serializes behind session persistence so a later saveSessionToken waits for the write.
 */
export function retryDurableCollectionNotificationRetirement(): Promise<void> {
  const outcome = serializeSessionPersistence(() => retireCollectionNotifications());
  void outcome.then(
    () => undefined,
    (error: unknown) => {
      captureException(error, {
        source: "auth-session-retirement-retry",
        retiredLifetime: true,
      });
    },
  );
  return outcome;
}

/** Clear the session token (logout). */
export async function clearSessionToken(): Promise<void> {
  invalidateSessionPersistence();
  const nativeOutcome = disableWhoopUploads().then(
    () => ({ status: "fulfilled" as const }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
  // Start durable alert retirement immediately; the promise waits only for the
  // local generation write, never for Apple notification removal.
  const retirementOutcome = retireCollectionNotifications().then(
    () => ({ status: "fulfilled" as const }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );

  const serializedCleanup = await serializeSessionPersistence(async () => {
    const intentResult: PromiseSettledResult<string> = (
      await Promise.allSettled([persistWhoopCleanupIntent()])
    )[0];
    // Await the revocation write before deleting credentials so a process death
    // cannot clear the keychain while the prior generation file is still current.
    // A rejected write still proceeds to every credential delete below.
    const retirement = await retirementOutcome;
    const credentialResults = await Promise.allSettled([
      deleteSecureStoreItem(SESSION_TOKEN_KEY),
      SecureStore.deleteItemAsync(SESSION_USER_KEY),
      deleteSecureStoreItem(SESSION_OWNER_NONCE_KEY),
    ]);

    if (intentResult.status === "rejected") {
      const native = await nativeOutcome;
      if (native.status === "rejected") {
        sessionAdoptionFailure = native.reason;
        hasSessionAdoptionFailure = true;
      } else {
        hasSessionAdoptionFailure = false;
      }
      return { credentialResults, intentResult, native, retirement };
    }

    hasSessionAdoptionFailure = false;
    return { credentialResults, intentResult, native: null, retirement };
  });

  const native = serializedCleanup.native ?? (await nativeOutcome);
  let intentClearResult: PromiseSettledResult<void>[] = [];
  if (serializedCleanup.intentResult.status === "fulfilled" && native.status === "fulfilled") {
    const intentId = serializedCleanup.intentResult.value;
    intentClearResult = await Promise.allSettled([
      serializeSessionPersistence(() => clearWhoopCleanupIntent(intentId)),
    ]);
  }
  const failures = [
    ...(serializedCleanup.intentResult.status === "rejected"
      ? [serializedCleanup.intentResult.reason]
      : []),
    ...(native.status === "rejected" ? [native.reason] : []),
    ...(serializedCleanup.retirement.status === "rejected"
      ? [serializedCleanup.retirement.reason]
      : []),
    ...serializedCleanup.credentialResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    ),
    ...intentClearResult.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
  ];
  if (failures.length > 0) {
    const error =
      failures.length === 1 ? failures[0] : new AggregateError(failures, "Session cleanup failed");
    captureException(error, { source: "auth-session-cleanup", retiredLifetime: true });
    throw error;
  }
}

/** Rotate the opaque owner marker whenever a server session is adopted. */
export async function rotateSessionOwnerNonce(): Promise<string> {
  const nonce = createAccountErasureCleanupNonce();
  const writeGeneration = sessionPersistenceGeneration;
  await serializeSessionPersistence(async () => {
    if (writeGeneration !== sessionPersistenceGeneration) return;
    await writeSecureStoreItem(SESSION_OWNER_NONCE_KEY, nonce);
  });
  return nonce;
}

/** Restore the owner marker that belongs to a session surviving an app restart. */
export async function getOrCreateSessionOwnerNonce(): Promise<string> {
  const readGeneration = sessionPersistenceGeneration;
  return serializeSessionPersistence(async () => {
    const stored = await readSecureStoreItem(SESSION_OWNER_NONCE_KEY);
    const parsed = stored === null ? null : z.uuid().safeParse(stored);
    if (parsed?.success && readGeneration === sessionPersistenceGeneration) {
      return parsed.data;
    }

    const nonce = createAccountErasureCleanupNonce();
    if (readGeneration === sessionPersistenceGeneration) {
      await writeSecureStoreItem(SESSION_OWNER_NONCE_KEY, nonce);
    }
    return nonce;
  });
}
