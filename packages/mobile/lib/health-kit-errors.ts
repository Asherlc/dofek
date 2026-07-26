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
