export function canonicalizeTimestampForExternalId(timestamp: string): string {
  const milliseconds = Date.parse(timestamp);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid timestamp for external ID: ${timestamp}`);
  }
  return new Date(milliseconds).toISOString();
}
