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
  const normalized = message.toLowerCase();
  return (
    normalized.includes("fetch failed") &&
    (normalized.includes("timed out") || normalized.includes("timeout"))
  );
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
