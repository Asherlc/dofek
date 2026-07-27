import { z } from "zod";
import { readSecureStoreItem, writeSecureStoreItem } from "./secure-store-access";

export const DEVICE_ERASURE_CUTOFF_KEY = "dofek_device_erasure_cutoff_v1";

const TimestampSchema = z.string().datetime({ offset: true });

export async function loadDeviceErasureCutoff(): Promise<string | null> {
  const value = await readSecureStoreItem(DEVICE_ERASURE_CUTOFF_KEY);
  if (value === null) return null;
  const parsed = TimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Stored device erasure cutoff is invalid.");
  }
  return parsed.data;
}

export async function advanceDeviceErasureCutoff(
  candidate = new Date().toISOString(),
): Promise<string> {
  const parsedCandidate = TimestampSchema.parse(candidate);
  const current = await loadDeviceErasureCutoff();
  const next =
    current !== null && Date.parse(current) > Date.parse(parsedCandidate)
      ? current
      : parsedCandidate;
  await writeSecureStoreItem(DEVICE_ERASURE_CUTOFF_KEY, next);
  return next;
}

export function isAfterDeviceErasureCutoff(timestamp: string, cutoff: string): boolean {
  const parsedTimestamp = TimestampSchema.safeParse(timestamp);
  const parsedCutoff = TimestampSchema.safeParse(cutoff);
  if (!parsedTimestamp.success || !parsedCutoff.success) return false;
  return Date.parse(parsedTimestamp.data) > Date.parse(parsedCutoff.data);
}
