const HEALTHKIT_DATABASE_INACCESSIBLE_CODE = "HEALTHKIT_DATABASE_INACCESSIBLE";

export const HEALTHKIT_DATABASE_INACCESSIBLE_MESSAGE =
  "Device locked — unlock to sync Apple Health data";

export function isHealthKitDatabaseInaccessible(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === HEALTHKIT_DATABASE_INACCESSIBLE_CODE
  );
}

export function isTransientNetworkErrorMessage(message: string): boolean {
  // Match the React Native fetch failure shapes seen in DOFEK-MOBILE-19, including
  // when the message is prefixed by sync-stage labels or TRPC wrappers. iOS surfaces
  // the same class of transient failure two ways: a request timeout
  // (NSURLErrorTimedOut) and a dropped connection (NSURLErrorNetworkConnectionLost,
  // "The network connection was lost.").
  if (message.includes(";")) return false;
  return /fetch failed:\s*(?:UnexpectedException:\s*)?(?:the request timed out\.|the network connection was lost\.|the Internet connection appears to be offline\.|cancelled|canceled)(?: \(at [^)]+\))?$/i.test(
    message,
  );
}

export function isBackgroundHealthKitTransientNetworkError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let matched = false;
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (current instanceof SyntaxError || current.name === "ZodError") return false;
    matched ||= isTransientNetworkErrorMessage(current.message);
    current = current.cause;
  }
  return matched || (typeof current === "string" && isTransientNetworkErrorMessage(current));
}

export const HEALTHKIT_BACKGROUND_SENTRY_SOURCE = "bg-healthkit-sync";

function isBackgroundSyncSource(source: string | undefined): boolean {
  return (
    source === HEALTHKIT_BACKGROUND_SENTRY_SOURCE ||
    source === "bg-accel-sync" ||
    source === "whoop-ble-imu-upload" ||
    source === "whoop-ble-realtime-upload" ||
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
