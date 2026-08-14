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
  return /fetch failed.*(the request timed out|the network connection was lost)/i.test(message);
}

export function isBackgroundHealthKitTransientNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    if (isTransientNetworkErrorMessage(error.message)) {
      return true;
    }
    if (error.cause !== undefined) {
      return isBackgroundHealthKitTransientNetworkError(error.cause);
    }
    return false;
  }
  return isTransientNetworkErrorMessage(String(error));
}

export const HEALTHKIT_BACKGROUND_SENTRY_SOURCE = "bg-healthkit-sync";

function isBackgroundSyncSentrySource(source: string | undefined): boolean {
  return (
    source === HEALTHKIT_BACKGROUND_SENTRY_SOURCE ||
    source === "bg-accel-sync" ||
    (source?.startsWith("health-kit-") ?? false)
  );
}

/**
 * A background sensor sync that fails on a transient network error (timeout or
 * dropped connection) is not actionable — the next foreground delivery retries and
 * succeeds. These must be dropped from every error-tracking destination (Sentry and
 * PostHog), not just Sentry, so the check lives here rather than in Sentry's
 * `beforeSend`.
 */
export function shouldSuppressBackgroundTransientNetworkError(
  error: unknown,
  source: string | undefined,
): boolean {
  return isBackgroundSyncSentrySource(source) && isBackgroundHealthKitTransientNetworkError(error);
}
