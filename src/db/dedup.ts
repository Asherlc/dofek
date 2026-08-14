/**
 * Check whether a "relation does not exist" error occurred.
 * Postgres error code 42P01 = undefined_table.
 */
export function isRelationMissingError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  if ("code" in error && error.code === "42P01") return true;
  if (error instanceof Error && error.message.includes("does not exist")) return true;
  if (error instanceof AggregateError) {
    return error.errors.some(isRelationMissingError);
  }
  return false;
}
