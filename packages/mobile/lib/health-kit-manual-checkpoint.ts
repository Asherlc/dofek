import { z } from "zod";
import { MANUAL_HEALTH_KIT_SYNC_STAGES } from "./health-kit-sync";
import type { ManualHealthKitSyncStage } from "./health-kit-sync-types";
import {
  deleteSecureStoreItem,
  readSecureStoreItem,
  writeSecureStoreItem,
} from "./secure-store-access";
import { captureException } from "./telemetry";

const MANUAL_HEALTH_KIT_CHECKPOINT_KEY = "dofek_manual_health_kit_checkpoint_v1";

export interface ManualHealthKitCheckpoint {
  requestId: string;
  userId: string;
  startDate: string;
  endDate: string;
  nextStage: ManualHealthKitSyncStage;
  requiresResume: boolean;
}

const TimestampSchema = z.string().datetime({ offset: true });

const ManualHealthKitCheckpointSchema = z
  .object({
    requestId: z.string().min(1),
    userId: z.string().min(1),
    startDate: TimestampSchema,
    endDate: TimestampSchema,
    nextStage: z.custom<ManualHealthKitSyncStage>(
      (value) =>
        typeof value === "string" &&
        MANUAL_HEALTH_KIT_SYNC_STAGES.some((stageIdentifier) => stageIdentifier === value),
      { message: "Apple Health sync checkpoint stage is invalid." },
    ),
    requiresResume: z.boolean(),
  })
  .refine((checkpoint) => Date.parse(checkpoint.startDate) < Date.parse(checkpoint.endDate), {
    message: "Apple Health sync checkpoint window is invalid.",
    path: ["endDate"],
  });

function parseStoredCheckpoint(raw: string): ManualHealthKitCheckpoint {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    captureException(error, { source: "health-kit-manual-checkpoint-parse" });
    throw new Error("Stored Apple Health sync checkpoint is invalid.");
  }
  const parsed = ManualHealthKitCheckpointSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Stored Apple Health sync checkpoint is invalid.");
  }
  return parsed.data;
}

function parseStoredCheckpointForPurge(raw: string): ManualHealthKitCheckpoint | null {
  try {
    return parseStoredCheckpoint(raw);
  } catch (error) {
    captureException(error, { source: "health-kit-manual-checkpoint-purge" });
    return null;
  }
}

/** Loads the pending request only when it belongs to the authenticated account. */
export async function loadManualHealthKitCheckpoint(
  userId: string,
): Promise<ManualHealthKitCheckpoint | null> {
  const raw = await readSecureStoreItem(MANUAL_HEALTH_KIT_CHECKPOINT_KEY);
  if (raw === null) return null;
  const checkpoint = parseStoredCheckpoint(raw);
  return checkpoint.userId === userId ? checkpoint : null;
}

/**
 * Persists progress for one request. A different pending request must be
 * cleared first so a retired operation cannot overwrite its replacement.
 */
export async function saveManualHealthKitCheckpoint(
  checkpoint: ManualHealthKitCheckpoint,
): Promise<void> {
  const next = ManualHealthKitCheckpointSchema.parse(checkpoint);
  const raw = await readSecureStoreItem(MANUAL_HEALTH_KIT_CHECKPOINT_KEY);
  if (raw !== null) {
    const existing = parseStoredCheckpoint(raw);
    if (existing.requestId !== next.requestId) {
      throw new Error("A different Apple Health sync request is already pending. Clear it first.");
    }
  }
  await writeSecureStoreItem(MANUAL_HEALTH_KIT_CHECKPOINT_KEY, JSON.stringify(next));
}

/** Clears the pending request only when both the account and request match. */
export async function clearManualHealthKitCheckpoint(
  userId: string,
  requestId: string,
): Promise<void> {
  const raw = await readSecureStoreItem(MANUAL_HEALTH_KIT_CHECKPOINT_KEY);
  if (raw === null) return;
  const existing = parseStoredCheckpoint(raw);
  if (existing.userId === userId && existing.requestId === requestId) {
    await deleteSecureStoreItem(MANUAL_HEALTH_KIT_CHECKPOINT_KEY);
  }
}

/**
 * Account cleanup deletes the pending request even when its payload can no
 * longer be parsed, because a corrupt request can never be resumed.
 */
export async function purgeManualHealthKitCheckpoint(userId: string): Promise<void> {
  const raw = await readSecureStoreItem(MANUAL_HEALTH_KIT_CHECKPOINT_KEY);
  if (raw === null) return;
  const existing = parseStoredCheckpointForPurge(raw);
  if (existing === null || existing.userId === userId) {
    await deleteSecureStoreItem(MANUAL_HEALTH_KIT_CHECKPOINT_KEY);
  }
}
