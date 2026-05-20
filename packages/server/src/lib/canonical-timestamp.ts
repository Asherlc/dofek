import { z } from "zod";

const externalIdTimestampSchema = z.string().datetime({ offset: true });

export function canonicalizeTimestampForExternalId(timestamp: string): string {
  const parsedTimestamp = externalIdTimestampSchema.safeParse(timestamp);
  if (!parsedTimestamp.success) {
    throw new Error(`Invalid timestamp for external ID: ${timestamp}`);
  }
  return new Date(parsedTimestamp.data).toISOString();
}
