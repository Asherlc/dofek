/**
 * Parse a Postgres range string like "['2026-03-12T21:37:00.000Z','2026-03-12T21:56:00.000Z')"
 * into start/end Date objects.
 *
 * WHOOP's internal API returns time ranges in this format for workouts and other activities.
 */
export function parseDuringRange(during: string): { start: Date; end: Date } {
  const match = during.match(/[[(]'([^']+)','([^']+)'/);
  if (!match?.[1] || !match?.[2]) {
    throw new Error(`Could not parse 'during' range: ${during}`);
  }
  return { start: new Date(match[1]), end: new Date(match[2]) };
}
