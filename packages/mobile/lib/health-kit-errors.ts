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
  // Match the React Native fetch timeout shape seen in DOFEK-MOBILE-19, including
  // when the message is prefixed by sync-stage labels or TRPC wrappers.
  return /fetch failed.*the request timed out/i.test(message);
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

export function isHealthKitSentrySource(source: string | undefined): boolean {
  return (
    source === HEALTHKIT_BACKGROUND_SENTRY_SOURCE || (source?.startsWith("health-kit-") ?? false)
  );
}
