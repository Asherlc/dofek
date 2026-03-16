/**
 * Extracted CLI utility functions — testable without side effects.
 */

/** Parse `--since-days=N` from an argv array, defaulting to 7. */
export function parseSinceDays(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith("--since-days="));
  if (arg) return parseInt(arg.split("=")[1] ?? "7", 10);
  return 7;
}

/** Compute the "since" cutoff date for sync/import operations. */
export function computeSinceDate(days: number, fullSync: boolean): Date {
  return fullSync ? new Date(0) : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
