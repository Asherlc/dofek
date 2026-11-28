const HEALTHKIT_AUTHORIZATION_NOT_DETERMINED_CODE = "HEALTHKIT_AUTHORIZATION_NOT_DETERMINED";
const HEALTHKIT_DATABASE_INACCESSIBLE_CODE = "HEALTHKIT_DATABASE_INACCESSIBLE";

/** Matches the native bridge code for Apple's errorAuthorizationNotDetermined. */
export function isHealthKitAuthorizationNotDetermined(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === HEALTHKIT_AUTHORIZATION_NOT_DETERMINED_CODE
  );
}

export function isHealthKitDatabaseInaccessible(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === HEALTHKIT_DATABASE_INACCESSIBLE_CODE
  );
}

// The mobile tRPC fetch wrapper reports a non-JSON HTTP 408 from the HealthKit
// quantity upload with this structured prefix (DOFEK-MOBILE-37). The status phrase
// and response preview are transport details; only the procedure and numeric
// status identify the known transient timeout.
const NON_JSON_PUSH_QUANTITY_SAMPLES_408 =
  /^Non-JSON tRPC response from healthKitSync\.pushQuantitySamples: 408(?: [^,]+)?,/;

export function isTransientNetworkErrorMessage(message: string): boolean {
  // Match the React Native fetch failure shapes seen in DOFEK-MOBILE-19, including
  // when the message is prefixed by sync-stage labels or TRPC wrappers. iOS surfaces
  // the same class of transient failure two ways: a request timeout
  // (NSURLErrorTimedOut) and a dropped connection (NSURLErrorNetworkConnectionLost,
  // "The network connection was lost.").
  if (message.includes(";")) return false;
  if (NON_JSON_PUSH_QUANTITY_SAMPLES_408.test(message)) return true;
  return /fetch failed:\s*(?:UnexpectedException:\s*)?(?:the request timed out\.|the network connection was lost\.|the Internet connection appears to be offline\.|cancelled|canceled)(?: \(at [^)]+\))?$/i.test(
    message,
  );
}

export function isBackgroundHealthKitTransientNetworkError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (current instanceof SyntaxError || current.name === "ZodError") return false;
    if (current.cause === undefined) return isTransientNetworkErrorMessage(current.message);
    current = current.cause;
  }
  return typeof current === "string" && isTransientNetworkErrorMessage(current);
}

export const HEALTHKIT_BACKGROUND_SENTRY_SOURCE = "bg-healthkit-sync";

function isBackgroundSyncSource(source: string | undefined): boolean {
  return (
    source === HEALTHKIT_BACKGROUND_SENTRY_SOURCE ||
    source === "bg-accel-sync" ||
    source === "whoop-ble-imu-upload" ||
    source === "whoop-ble-realtime-upload" ||
    source === "apple-health-sync-log" ||
    (source?.startsWith("health-kit-") ?? false)
  );
}

/**
 * Known background transport outcomes belong in operational metrics and logs.
 * This classification does not establish that a later delivery will succeed.
 */
export function shouldSuppressBackgroundTransientNetworkError(
  error: unknown,
  source: string | undefined,
): boolean {
  return isBackgroundSyncSource(source) && isBackgroundHealthKitTransientNetworkError(error);
}
